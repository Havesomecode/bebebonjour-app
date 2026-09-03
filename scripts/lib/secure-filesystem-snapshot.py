#!/usr/bin/env python3
"""Descriptor-relative, bounded filesystem snapshots for local generation."""

import base64
import hashlib
import json
import os
import posixpath
import stat
import sys
from typing import NoReturn

ROOT_FD = 3
MAX_REQUEST_BYTES = 64 * 1024
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024
DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024
DEFAULT_MAX_FILES = 2048


class BoundaryError(Exception):
    pass


def reject() -> NoReturn:
    raise BoundaryError("secure filesystem boundary rejected")


def exact_object(value, keys):
    return isinstance(value, dict) and set(value.keys()) == set(keys)


def relative_parts(value):
    if not isinstance(value, str) or not value or "\x00" in value or value.startswith("/"):
        reject()
    parts = value.split("/")
    if any(part in ("", ".", "..") for part in parts):
        reject()
    return parts


def validate_directory(metadata, private):
    if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid():
        reject()
    forbidden = 0o077 if private else 0o022
    if metadata.st_mode & forbidden:
        reject()


def validate_regular(metadata, maximum_bytes):
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_uid != os.getuid()
        or metadata.st_nlink != 1
        or metadata.st_mode & 0o022
        or metadata.st_size < 0
        or metadata.st_size > maximum_bytes
    ):
        reject()


def fingerprint(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_uid,
        metadata.st_nlink,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


class Snapshot:
    def __init__(self, root_fd, private_directories, maximum_file_bytes, maximum_total_bytes, maximum_files):
        self.root_fd = os.dup(root_fd)
        self.private_directories = private_directories
        self.maximum_file_bytes = maximum_file_bytes
        self.maximum_total_bytes = maximum_total_bytes
        self.maximum_files = maximum_files
        self.directories = []
        self.files = []
        self.by_path = {}
        self.directory_by_path = {"": self.root_fd}
        self.total_bytes = 0
        root_metadata = os.fstat(self.root_fd)
        validate_directory(root_metadata, private_directories)
        self.directories.append((self.root_fd, fingerprint(root_metadata)))

    def close(self):
        for descriptor, _ in reversed(self.files):
            try:
                os.close(descriptor)
            except OSError:
                pass
        for descriptor, _ in reversed(self.directories):
            try:
                os.close(descriptor)
            except OSError:
                pass
        self.files.clear()
        self.directories.clear()

    def open_directory(self, relative_path):
        parts = relative_parts(relative_path)
        descriptor = self.root_fd
        traversed = []
        for component in parts:
            traversed.append(component)
            current_path = "/".join(traversed)
            cached = self.directory_by_path.get(current_path)
            if cached is not None:
                descriptor = cached
                continue
            child = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                dir_fd=descriptor,
            )
            child_metadata = os.fstat(child)
            validate_directory(child_metadata, self.private_directories)
            self.directories.append((child, fingerprint(child_metadata)))
            self.directory_by_path[current_path] = child
            descriptor = child
        return descriptor

    def open_file(self, relative_path):
        if relative_path in self.by_path:
            return self.by_path[relative_path]
        parts = relative_parts(relative_path)
        parent_path = "/".join(parts[:-1])
        parent = self.root_fd if not parent_path else self.open_directory(parent_path)
        path_metadata = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if stat.S_ISLNK(path_metadata.st_mode):
            reject()
        descriptor = os.open(
            parts[-1],
            os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
            dir_fd=parent,
        )
        opened_metadata = os.fstat(descriptor)
        validate_regular(opened_metadata, self.maximum_file_bytes)
        if (path_metadata.st_dev, path_metadata.st_ino) != (opened_metadata.st_dev, opened_metadata.st_ino):
            reject()
        data = self.read_file(descriptor, opened_metadata)
        item = {
            "rootPath": relative_path,
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "data": data,
        }
        self.by_path[relative_path] = item
        return item

    def read_file(self, descriptor, before):
        if len(self.files) >= self.maximum_files:
            reject()
        chunks = []
        total = 0
        while total <= self.maximum_file_bytes:
            chunk = os.read(descriptor, min(64 * 1024, self.maximum_file_bytes + 1 - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        if total > self.maximum_file_bytes or total != before.st_size:
            reject()
        self.total_bytes += total
        if self.total_bytes > self.maximum_total_bytes:
            reject()
        after = os.fstat(descriptor)
        if fingerprint(before) != fingerprint(after):
            reject()
        self.files.append((descriptor, fingerprint(before)))
        return b"".join(chunks)

    def walk(self, relative_root, prefix, excluded):
        directory = self.open_directory(relative_root)
        inventory = []

        def visit(descriptor, current_root_path, current_inventory_path):
            before = os.fstat(descriptor)
            validate_directory(before, self.private_directories)
            names = sorted(os.listdir(descriptor))
            for name in names:
                if not isinstance(name, str) or name in ("", ".", "..") or "/" in name or "\x00" in name:
                    reject()
                root_path = posixpath.join(current_root_path, name)
                inventory_path = posixpath.join(current_inventory_path, name) if current_inventory_path else name
                metadata = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                if stat.S_ISLNK(metadata.st_mode):
                    reject()
                if stat.S_ISDIR(metadata.st_mode):
                    child = os.open(
                        name,
                        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                        dir_fd=descriptor,
                    )
                    child_metadata = os.fstat(child)
                    validate_directory(child_metadata, self.private_directories)
                    if (metadata.st_dev, metadata.st_ino) != (child_metadata.st_dev, child_metadata.st_ino):
                        os.close(child)
                        reject()
                    self.directories.append((child, fingerprint(child_metadata)))
                    self.directory_by_path[root_path] = child
                    visit(child, root_path, inventory_path)
                elif stat.S_ISREG(metadata.st_mode):
                    if inventory_path in excluded:
                        continue
                    item = self.open_file(root_path)
                    logical_path = posixpath.join(prefix, inventory_path) if prefix else inventory_path
                    inventory.append({
                        "path": logical_path,
                        "bytes": item["bytes"],
                        "sha256": item["sha256"],
                    })
                else:
                    reject()
            after = os.fstat(descriptor)
            if fingerprint(before) != fingerprint(after):
                reject()

        visit(directory, relative_root, "")
        return inventory

    def validate(self):
        for descriptor, expected in self.files:
            if fingerprint(os.fstat(descriptor)) != expected:
                reject()
        for descriptor, expected in self.directories:
            if fingerprint(os.fstat(descriptor)) != expected:
                reject()


def bounded_positive(value, fallback, maximum):
    if value is None:
        return fallback
    if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > maximum:
        reject()
    return value


def request_read_file(request):
    if not exact_object(request, {"operation", "relativePath", "maximumBytes", "privateDirectories", "exactMode"}):
        reject()
    maximum = bounded_positive(request["maximumBytes"], 16_384, DEFAULT_MAX_FILE_BYTES)
    exact_mode = request["exactMode"]
    if exact_mode is not None and (not isinstance(exact_mode, int) or exact_mode < 0 or exact_mode > 0o777):
        reject()
    snapshot = Snapshot(ROOT_FD, request["privateDirectories"] is True, maximum, maximum, 1)
    try:
        try:
            item = snapshot.open_file(request["relativePath"])
        except FileNotFoundError:
            return {"missing": True}
        descriptor, _ = snapshot.files[-1]
        metadata = os.fstat(descriptor)
        if exact_mode is not None and stat.S_IMODE(metadata.st_mode) != exact_mode:
            reject()
        snapshot.validate()
        return {"dataBase64": base64.b64encode(item["data"]).decode("ascii")}
    finally:
        snapshot.close()


def request_collect(request):
    required = {
        "operation", "inventoryRoot", "inventoryPrefix", "excludedPaths", "pagePath",
        "pageManifestPath", "transcriptPath", "transcriptManifestPath", "requiredPaths",
        "maximumFileBytes", "maximumTotalBytes", "maximumFiles",
    }
    if not exact_object(request, required):
        reject()
    if not isinstance(request["inventoryPrefix"], str):
        reject()
    if request["inventoryPrefix"]:
        relative_parts(request["inventoryPrefix"])
    for field in ("excludedPaths", "requiredPaths"):
        if not isinstance(request[field], list) or not all(isinstance(value, str) for value in request[field]):
            reject()
    excluded = set(request["excludedPaths"])
    for value in excluded:
        relative_parts(value)
    maximum_file_bytes = bounded_positive(request["maximumFileBytes"], DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_FILE_BYTES)
    maximum_total_bytes = bounded_positive(request["maximumTotalBytes"], DEFAULT_MAX_TOTAL_BYTES, 1024 * 1024 * 1024)
    maximum_files = bounded_positive(request["maximumFiles"], DEFAULT_MAX_FILES, 8192)
    snapshot = Snapshot(ROOT_FD, False, maximum_file_bytes, maximum_total_bytes, maximum_files)
    try:
        try:
            files = snapshot.walk(request["inventoryRoot"], request["inventoryPrefix"], excluded)
            page = snapshot.open_file(request["pagePath"])
            transcript = snapshot.open_file(request["transcriptPath"])
            for required_path in request["requiredPaths"]:
                snapshot.open_file(required_path)
        except FileNotFoundError:
            return {"missing": True}
        represented = {item["path"]: item for item in files}

        def represent_digest(item, configured_manifest_path):
            manifest_path = configured_manifest_path
            if manifest_path is None:
                inventory_root = request["inventoryRoot"]
                prefix = f"{inventory_root}/"
                if not item["rootPath"].startswith(prefix):
                    reject()
                relative = item["rootPath"][len(prefix):]
                manifest_path = posixpath.join(request["inventoryPrefix"], relative) \
                    if request["inventoryPrefix"] else relative
            relative_parts(manifest_path)
            existing = represented.get(manifest_path)
            manifest_item = {"path": manifest_path, "bytes": item["bytes"], "sha256": item["sha256"]}
            if existing is None:
                if configured_manifest_path is None:
                    reject()
                files.append(manifest_item)
                represented[manifest_path] = manifest_item
            elif existing != manifest_item:
                reject()

        represent_digest(page, request["pageManifestPath"])
        represent_digest(transcript, request["transcriptManifestPath"])
        if not files or len(represented) != len(files):
            reject()
        snapshot.validate()
        files.sort(key=lambda item: item["path"])
        return {
            "files": files,
            "pageDigest": page["sha256"],
            "transcriptDigest": transcript["sha256"],
        }
    finally:
        snapshot.close()


def main():
    if sys.argv[1:] == ["--check"]:
        print("ok")
        return 0
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    if not raw or len(raw) > MAX_REQUEST_BYTES:
        reject()
    request = json.loads(raw.decode("utf-8"))
    if not isinstance(request, dict):
        reject()
    operation = request.get("operation")
    if operation == "read_file":
        response = request_read_file(request)
    elif operation == "collect":
        response = request_collect(request)
    else:
        reject()
    encoded = (json.dumps(response, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        reject()
    sys.stdout.buffer.write(encoded)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (BoundaryError, OSError, ValueError, UnicodeError, json.JSONDecodeError):
        sys.stderr.write("secure filesystem boundary rejected\n")
        raise SystemExit(2)
