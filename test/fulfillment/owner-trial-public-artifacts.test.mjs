import test from "node:test";
import { createServer } from "node:http";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOwnerTrialPublicArtifactResolver } from "../../src/fulfillment/owner-trial-completion-capabilities.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const SITE = "https://offline.convex.site";

function runtimeFixture() {
 const f=fixture(), prefix="deploy/_assets/blessed-arrival-1-0-0-r1/";
 const page=Buffer.from('<html><head><link rel="stylesheet" href="../_assets/blessed-arrival-1-0-0-r1/styles.css"></head><body><script type="module" src="../_assets/blessed-arrival-1-0-0-r1/app.js"></script><img src="../_assets/blessed-arrival-1-0-0-r1/og-image.svg"><audio src="../artifacts/audio/fr/intro.mp3"></audio></body></html>');
 f.blobs.set("page",page);Object.assign(f.files[0],{bytes:page.length,sha256:sha(page)});
 for(const [name,text]of Object.entries({"app.js":'import { progress } from "./phrase-progress.mjs"; console.log(progress);',"phrase-progress.mjs":'export const progress = 1;',"styles.css":'body { color: #123; }',"og-image.svg":'<svg xmlns="http://www.w3.org/2000/svg"></svg>'})){
  const bytes=Buffer.from(text),storageId=`runtime-${name}`;f.blobs.set(storageId,bytes);f.files.push({path:prefix+name,storageId,bytes:bytes.length,sha256:sha(bytes)});
 }
 return rebindManifest(f);
}
function rebindManifest(f){
 const bytes=Buffer.from(`${JSON.stringify({schemaVersion:"1.0",kind:"narration_review",revisionId:f.policy.revisionId,files:f.files},null,2)}\n`);
 f.manifestBytes=bytes;f.policy.manifestDigest=sha(bytes);f.request.artifactManifestDigest=sha(bytes);f.request.artifactSet.assetManifestDigest=sha(bytes);return f;
}
function runtimeResolver(f,reads=[]){return createOwnerTrialPublicArtifactResolver({policy:f.policy,token:"t".repeat(32),siteOrigin:SITE,revalidate:async()=>{},fetch:async(url,options)=>{
 assert.equal(new URL(url).origin,SITE);assert.equal(options.redirect,"error");const id=new URL(url).searchParams.get("storageId");reads.push(id);
 return new Response(f.blobs.get(id),{headers:{"cache-control":"private, no-store","content-type":"application/octet-stream"}});
}});}
test("runtime closure publishes all four approved bundle dependencies byte-exact without private JSON",async()=>{
 const f=runtimeFixture(),reads=[],result=await runtimeResolver(f,reads).resolve(f.request);
 const assets=result.files.filter(x=>x.publicPath.startsWith("_assets/"));assert.equal(assets.length,4);
 for(const file of assets){assert.deepEqual(file.bytes,f.blobs.get(f.files.find(x=>x.path===file.path).storageId));assert.equal(file.sha256,sha(file.bytes));}
 assert.equal(reads.includes("private"),false);assert.equal(result.files.some(x=>x.publicPath.endsWith(".json")),false);
 assert.deepEqual(result.manifestBytes,f.manifestBytes);
});


for(const mode of ["missingModule","duplicate","traversal","encoded","privateJson","privateModule","privateSvg","externalImport","missingImport","dynamicImport","cssEscape","svgScript","svgExternal","badBytes"]){
 test(`runtime closure fails closed on ${mode}`,async()=>{
  const f=runtimeFixture();const file=f.files.find(x=>x.path.endsWith("phrase-progress.mjs"));
  if(mode==="missingModule")f.files.splice(f.files.indexOf(file),1);
  if(mode==="duplicate")f.files.push({...file});
  if(mode==="traversal"||mode==="encoded")file.path=`deploy/_assets/blessed-arrival-1-0-0-r1/${mode==="traversal"?"../":"%2e%2e/"}phrase-progress.mjs`;
  if(mode==="privateJson")file.path="deploy/_assets/blessed-arrival-1-0-0-r1/page.json";
  const changed={privateModule:['phrase-progress.mjs','export const customerEmail = "private@example.test";'],privateSvg:['og-image.svg','<svg><text>ticketSecret</text></svg>'],externalImport:['app.js','import "https://attacker.example.test/module.mjs";'],missingImport:['app.js','import "./not-approved.mjs";'],dynamicImport:['app.js','import(window.unapproved);'],cssEscape:['styles.css','body { background: url(../../../artifacts/current/intake.json); }'],svgScript:['og-image.svg','<svg><script>alert(1)</script></svg>'],svgExternal:['og-image.svg','<svg><image href="https://attacker.example.test/image.svg"/></svg>']}[mode];
  if(changed){const target=f.files.find(x=>x.path.endsWith(changed[0])),bytes=Buffer.from(changed[1]);f.blobs.set(target.storageId,bytes);Object.assign(target,{bytes:bytes.length,sha256:sha(bytes)});}
  rebindManifest(f);if(mode==="badBytes")f.blobs.set(file.storageId,Buffer.from("transport-corruption"));
  await assert.rejects(()=>runtimeResolver(f).resolve(f.request));
 });
}


test("runtime bundle uses real anonymous-isolated HTTP byte transport and never reads private storage",async()=>{
 const f=runtimeFixture(),reads=[];
 const server=createServer((request,response)=>{
  const url=new URL(request.url,"http://localhost");assert.equal(url.pathname,"/completion/artifact");
  assert.equal(request.headers.authorization,`Bearer ${"t".repeat(32)}`);
  assert.equal(request.headers["x-bebebonjour-command-id"],f.request.artifactReadAuthority.commandId);
  const id=url.searchParams.get("storageId");assert.notEqual(id,"private");reads.push(id);
  response.writeHead(200,{"cache-control":"private, no-store","content-type":"application/octet-stream"});response.end(f.blobs.get(id));
 });
 await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 try{
  const resolver=createOwnerTrialPublicArtifactResolver({policy:f.policy,token:"t".repeat(32),siteOrigin:SITE,revalidate:async()=>{},fetch:(url,options)=>{
   const pinned=new URL(url);assert.equal(pinned.origin,SITE);
   return fetch(`http://127.0.0.1:${server.address().port}${pinned.pathname}${pinned.search}`,options);
  }});
  const result=await resolver.resolve(f.request);assert.equal(result.files.length,6);assert.equal(reads.length,6);
  for(const file of result.files.filter(x=>x.publicPath.startsWith("_assets/")))assert.equal(file.sha256,sha(f.blobs.get(f.files.find(x=>x.path===file.path).storageId)));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

function fixture() {
  const blobs = new Map([
    ["page", Buffer.from('<!doctype html><html><head><title>Fictional trial</title></head><body><audio controls src="../../artifacts/audio/fr/intro.mp3"></audio></body></html>')],
    ["audio", Buffer.from("offline audio transport fixture")],
    ["private", Buffer.from('{"customerEmail":"private@example.test"}')],
  ]);
  const files = [...blobs].map(([storageId, bytes]) => ({
    path: { page: "deploy/fr/index.html", audio: "artifacts/audio/fr/intro.mp3", private: "artifacts/current/intake.json" }[storageId],
    storageId, bytes: bytes.length, sha256: sha(bytes) }));
  const revisionId = "rev_owner_trial_offline";
  const manifestBytes = Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: "narration_review", revisionId, files }, null, 2)}\n`);
  const policy = { jobId: "job_owner_trial_" + "a".repeat(32), revisionId, manifestDigest: sha(manifestBytes) };
  const request = { jobId: policy.jobId, revisionId, environment: "test", product: "announcement-page",
    artifactSetId: "set_owner_trial_offline", artifactManifestDigest: policy.manifestDigest,
    artifactSet: { kind: "narration_review", revisionId, artifactSetId: "set_owner_trial_offline", assetManifestDigest: policy.manifestDigest, files },
    artifactReadAuthority: { workerId: "owner-trial-completion-worker", commandId: "command_offline", leaseToken: "lease_offline" },
    fenceExternalEffect: async (_fence, effect) => effect() };
  return { blobs, files, policy, request, manifestBytes };
}

test("trial publication reads only scoped HTML/audio with the real HTTP headers and pinned site origin", async () => {
  const value = fixture(); const reads = []; let checks = 0;
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: SITE,
    revalidate: async () => { checks += 1; }, fetch: async (url, options) => {
      const parsed = new URL(url); reads.push(parsed.searchParams.get("storageId"));
      assert.equal(parsed.origin, SITE); assert.equal(parsed.pathname, "/completion/artifact");
      assert.equal(parsed.searchParams.get("jobId"), value.policy.jobId);
      assert.equal(parsed.searchParams.get("revisionId"), value.policy.revisionId);
      assert.deepEqual(options.headers, { authorization: `Bearer ${"t".repeat(32)}`,
        "x-bebebonjour-worker-id": "owner-trial-completion-worker", "x-bebebonjour-command-id": "command_offline", "x-bebebonjour-lease-token": "lease_offline" });
      assert.equal(options.redirect, "error");
      return new Response(value.blobs.get(parsed.searchParams.get("storageId")), { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } });
    } });
  const result = await resolver.resolve(value.request);
  assert.deepEqual(reads, ["page", "audio"]); assert.ok(checks >= 3);
  assert.equal(result.entrypointPath, "fr/index.html");
  assert.deepEqual(result.files.map(file => file.publicPath), ["fr/index.html", "artifacts/audio/fr/intro.mp3"]);
  assert.deepEqual(result.manifestBytes, value.manifestBytes);
  assert.deepEqual(result.files[1].bytes, value.blobs.get("audio"));
  assert.match(result.files[0].bytes.toString(), /noindex, nofollow, noarchive/u);
  assert.match(result.files[0].bytes.toString(), /fictional-delegated-review-not-owner-acceptance/u);
  assert.match(result.files[0].bytes.toString(), /\.\.\/\.\.\/artifacts\/audio\/fr\/intro\.mp3/u);
});

test("trial publication refuses data-controlled artifact origins before exposing its credential", async () => {
  const value = fixture(); value.files[0].objectRef = { storageId: "page", url: "https://attacker.example.test/private" };
  let calls = 0;
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: SITE,
    revalidate: async () => {}, fetch: async url => { calls += 1; assert.equal(new URL(url).origin, SITE);
      return new Response(value.blobs.get(new URL(url).searchParams.get("storageId")), { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } }); } });
  await resolver.resolve(value.request); assert.equal(calls, 2);
  assert.throws(() => createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: "https://attacker.example.test", revalidate: async () => {} }), /Convex site origin/u);
});

test("trial publication checks persisted authority again before fetching each artifact", async () => {
  const value = fixture(); let checks = 0; let calls = 0;
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: SITE,
    revalidate: async () => { if (++checks > 1) throw new Error("ticket revoked"); }, fetch: async () => { calls += 1; throw new Error("must not fetch"); } });
  await assert.rejects(resolver.resolve(value.request), /ticket revoked/u); assert.equal(calls, 0);
});

test("trial publication rejects changed manifest bytes and changed downloaded artifact bytes", async () => {
  const value = fixture(); let calls = 0;
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: SITE,
    revalidate: async () => {}, fetch: async () => { calls += 1; return new Response("changed", { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } }); } });
  const changed = { ...value.request, artifactSet: structuredClone(value.request.artifactSet) };
  changed.artifactSet.files[0].sha256 = "f".repeat(64);
  await assert.rejects(resolver.resolve(changed), /manifest bytes changed/u); assert.equal(calls, 0);
  await assert.rejects(resolver.resolve(value.request), /artifact bytes changed/u); assert.equal(calls, 1);
});

test("trial publication refuses private provenance inside otherwise valid public HTML", async () => {
  const value = fixture(); const secretPage = Buffer.from('<html><head></head><body>z@havesomecode.io</body></html>');
  value.blobs.set("page", secretPage); value.files[0].bytes = secretPage.length; value.files[0].sha256 = sha(secretPage);
  value.policy.manifestDigest = sha(Buffer.from(`${JSON.stringify({ schemaVersion: "1.0", kind: "narration_review", revisionId: value.policy.revisionId, files: value.files }, null, 2)}\n`));
  value.request.artifactManifestDigest = value.policy.manifestDigest; value.request.artifactSet.assetManifestDigest = value.policy.manifestDigest;
  const resolver = createOwnerTrialPublicArtifactResolver({ policy: value.policy, token: "t".repeat(32), siteOrigin: SITE,
    revalidate: async () => {}, fetch: async url => new Response(value.blobs.get(new URL(url).searchParams.get("storageId")), { headers: { "cache-control": "private, no-store", "content-type": "application/octet-stream" } }) });
  await assert.rejects(resolver.resolve(value.request), /private provenance/u);
});
