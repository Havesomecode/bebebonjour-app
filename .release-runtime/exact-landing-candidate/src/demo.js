import { createDemoPlayback } from "./demo-playback.js";

void initialize();

async function initialize() {
const manifest = await loadManifest();
const playback = createDemoPlayback(manifest);

const elements = {
  profile: document.querySelector("#profile-select"),
  reset: document.querySelector("#reset-demo"),
  advance: document.querySelector("#advance-demo"),
  link: document.querySelector("#announcement-link"),
  completion: document.querySelector("#completion-note"),
  stepCount: document.querySelector("#step-count"),
  label: document.querySelector("#step-label"),
  description: document.querySelector("#step-description"),
  name: document.querySelector("#baby-name"),
  email: document.querySelector("#customer-email"),
  publicStatus: document.querySelector("#public-status"),
  canonicalStatus: document.querySelector("#canonical-status"),
  revision: document.querySelector("#revision-id"),
  timeline: document.querySelector("#timeline"),
};

elements.profile.addEventListener("change", () => {
  playback.select(elements.profile.value);
  render();
});
elements.advance.addEventListener("click", () => {
  playback.advance();
  render();
});
elements.reset.addEventListener("click", () => {
  playback.reset();
  elements.profile.value = "amal";
  render();
  elements.advance.focus();
});

render();

async function loadManifest() {
  const response = await fetch("./demo/workflow.json", {
    cache: "no-store",
    credentials: "omit",
  });
  if (!response.ok) throw new Error("La démonstration synthétique est indisponible.");
  return response.json();
}

function render() {
  const state = playback.snapshot();
  const { announcement, step } = state;
  elements.stepCount.textContent = `Étape ${state.stepIndex + 1} sur ${state.stepCount}`;
  elements.label.textContent = step.label;
  elements.description.textContent = step.description;
  elements.name.textContent = announcement.intake.baby.firstName;
  elements.email.textContent = announcement.intake.customer.email;
  elements.publicStatus.textContent = step.status;
  elements.canonicalStatus.textContent = step.canonicalState;
  elements.revision.textContent = step.revisionId || "En attente";
  elements.advance.hidden = state.completed;
  elements.link.hidden = !state.completed;
  elements.completion.hidden = !state.completed;
  if (state.completed) elements.link.href = `./${state.announcementPath}`;

  elements.timeline.replaceChildren(...announcement.timeline.map((entry, index) => {
    const item = document.createElement("li");
    item.className = index < state.stepIndex
      ? "timeline-step is-complete"
      : index === state.stepIndex
        ? "timeline-step is-current"
        : "timeline-step";
    if (index === state.stepIndex) item.setAttribute("aria-current", "step");
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.textContent = index < state.stepIndex ? "✓" : String(index + 1);
    const copy = document.createElement("span");
    copy.textContent = entry.label;
    item.append(marker, copy);
    return item;
  }));
}
}
