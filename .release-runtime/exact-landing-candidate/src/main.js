import "./styles.css";
import { FulfillmentApiError, createFulfillmentClient } from "./fulfillment-client.js";

const SESSION_KEY = "bebebonjour.test-a.job";
const STATUS_COPY = Object.freeze({
  payment_pending: ["Paiement test en attente", "La demande privée est créée. Le paiement reste lié à cette référence."],
  generation_pending: ["Création en préparation", "Le paiement test est confirmé. La génération peut commencer côté opérateur."],
  review_required: ["Relecture en cours", "Le contenu et les narrations doivent être approuvés sur leur révision exacte."],
  publication_ready: ["Prêt à publier", "Toutes les validations éditoriales sont réunies. Le lien n’est pas encore livré."],
  delivery_ready: ["Livraison en attente", "Le lien stable est prêt, mais l’email test n’a pas encore été accepté."],
  complete: ["Faire-part prêt", "Le lien relu a été accepté par l’adaptateur email local."],
});

const api = createTestApi();
const form = document.querySelector("#intake-form");
const formMessage = document.querySelector("#form-message");
const jobStatus = document.querySelector("#job-status");
const statusTitle = document.querySelector("#status-title");
const statusCopy = document.querySelector("#status-copy");
const jobReference = document.querySelector("#job-reference");
const refreshButton = document.querySelector("#refresh-status");
const checkoutButton = document.querySelector("#create-checkout");
const announcementLink = document.querySelector("#announcement-link");
let currentJob = restoreJob();

setupReveals();
setupNavigation();

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!api) {
    setFormMessage("Le parcours TEST-A n’est pas configuré sur cette page.", true);
    return;
  }
  const submitButton = form.querySelector("button[type='submit']");
  setBusy(submitButton, true);
  setFormMessage("Création de la demande test…", false);

  try {
    const submission = await api.submitIntake(intakeFromForm(form));
    currentJob = { jobId: submission.jobId, intakeToken: submission.intakeToken };
    saveJob(currentJob);
    form.hidden = true;
    renderStatus({
      jobId: submission.jobId,
      status: submission.status,
      payment: "pending",
      review: "not_ready",
      delivery: "not_ready",
    });
    setFormMessage("", false);
  } catch (error) {
    setFormMessage(publicMessage(error), true);
  } finally {
    setBusy(submitButton, false);
  }
});

refreshButton?.addEventListener("click", () => refreshStatus());
checkoutButton?.addEventListener("click", async () => {
  if (!api || !currentJob) return;
  setBusy(checkoutButton, true);
  try {
    const checkout = await api.createCheckout(currentJob.jobId, currentJob.intakeToken);
    window.location.assign(checkout.checkoutUrl);
  } catch (error) {
    statusCopy.textContent = publicMessage(error);
    setBusy(checkoutButton, false);
  }
});

if (api && currentJob) {
  form.hidden = true;
  refreshStatus();
}

async function refreshStatus() {
  if (!api || !currentJob) return;
  setBusy(refreshButton, true);
  try {
    renderStatus(await api.getStatus(currentJob.jobId, currentJob.intakeToken));
  } catch (error) {
    if (error instanceof FulfillmentApiError && error.code === "job_not_found") {
      clearJob();
      form.hidden = false;
      jobStatus.hidden = true;
      setFormMessage(error.message, true);
    } else {
      statusCopy.textContent = publicMessage(error);
    }
  } finally {
    setBusy(refreshButton, false);
  }
}

function createTestApi() {
  try {
    return createFulfillmentClient({
      baseUrl: import.meta.env.VITE_FULFILLMENT_API_BASE_URL,
      getTestAccessToken: requestTestAccessToken,
    });
  } catch {
    return null;
  }
}

function requestTestAccessToken() {
  return window.prompt(
    "Jeton d’accès TEST-A (conservé uniquement en mémoire jusqu’au rechargement de la page) :",
  );
}

function intakeFromForm(element) {
  const data = new FormData(element);
  const email = String(data.get("email") || "").trim().toLowerCase();
  if (!email.endsWith(".test")) {
    throw new FulfillmentApiError(400, "invalid_intake", "Utilisez une adresse synthétique se terminant par .test.");
  }
  const languages = data.getAll("languages").map(String);
  if (languages.length === 0) {
    throw new FulfillmentApiError(400, "invalid_intake", "Choisissez au moins une langue.");
  }

  const baby = {
    firstName: String(data.get("firstName") || "").trim(),
    gender: String(data.get("gender") || ""),
  };
  const nameArabic = String(data.get("nameArabic") || "").trim();
  const birthDate = String(data.get("birthDate") || "");
  if (nameArabic) baby.nameArabic = nameArabic;
  if (birthDate) baby.birthDate = birthDate;

  const intake = {
    schemaVersion: "1.0",
    customer: { email, consent: data.get("consent") === "on" },
    baby,
    languages,
    voicePreference: {
      enabled: data.get("voiceEnabled") === "on",
      gender: String(data.get("voiceGender") || "neutral"),
    },
  };
  const religion = String(data.get("religion") || "");
  const request = String(data.get("request") || "").trim();
  if (religion) intake.context = { religion };
  if (request) intake.request = request;
  return intake;
}

function renderStatus(status) {
  const copy = STATUS_COPY[status.status] || ["Demande en cours", "Actualisez pour suivre son avancement."];
  jobStatus.hidden = false;
  statusTitle.textContent = copy[0];
  statusCopy.textContent = copy[1];
  jobReference.textContent = status.jobId;
  checkoutButton.hidden = status.payment === "paid";

  const delivered = status.status === "complete" && typeof status.stableUrl === "string";
  announcementLink.hidden = !delivered;
  if (delivered) announcementLink.href = status.stableUrl;
}

function setupReveals() {
  const reveals = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) {
    reveals.forEach((element) => element.classList.add("visible"));
    return;
  }
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, index) => {
        if (!entry.isIntersecting) return;
        setTimeout(() => entry.target.classList.add("visible"), index * 80);
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12 },
  );
  reveals.forEach((element) => observer.observe(element));
}

function setupNavigation() {
  let lastY = 0;
  const nav = document.querySelector("nav");
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    if (nav) nav.style.transform = y > lastY && y > 100 ? "translateY(-100%)" : "translateY(0)";
    lastY = y;
  }, { passive: true });
}

function setBusy(element, busy) {
  if (!element) return;
  element.disabled = busy;
  element.setAttribute("aria-busy", String(busy));
}

function setFormMessage(message, isError) {
  formMessage.textContent = message;
  formMessage.classList.toggle("error", isError);
}

function publicMessage(error) {
  return error instanceof FulfillmentApiError
    ? error.message
    : "Le service est momentanément indisponible. Réessayez.";
}

function saveJob(job) {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(job));
  } catch {
    // The in-memory copy keeps the current tab usable when storage is unavailable.
  }
}

function restoreJob() {
  try {
    const value = JSON.parse(sessionStorage.getItem(SESSION_KEY));
    return typeof value?.jobId === "string" && typeof value?.intakeToken === "string" ? value : null;
  } catch {
    return null;
  }
}

function clearJob() {
  currentJob = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Nothing else to clear.
  }
}
