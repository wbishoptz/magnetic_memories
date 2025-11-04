let selectedPack = null;
let customerEmail = "";
let uploadedFiles = [];

const payButton = document.getElementById("payButton");
const emailInput = document.getElementById("email");
const statusText = document.getElementById("status");

// --- Email validation UI helper ---
function setEmailValidityUI(isValid) {
  const emailEl = document.getElementById("email");
  const errEl = document.getElementById("emailError");
  emailEl.classList.toggle("input-error", !isValid);
  errEl.style.display = isValid ? "none" : "block";
  emailEl.setAttribute("aria-invalid", String(!isValid));
}

// --- Enforce pay button enable/disable state ---
function enforcePayButtonState() {
  const validEmail = /\S+@\S+\.\S+/.test(customerEmail);
  const correctFiles =
    uploadedFiles.length > 0 && uploadedFiles.length === Number(selectedPack);
  payButton.disabled = !(selectedPack && validEmail && correctFiles);
}

// --- Listen for pack selection ---
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", (e) => {
    selectedPack = e.target.value;
    enforcePayButtonState();
  });
});

// --- Listen for email input ---
emailInput.addEventListener("input", () => {
  customerEmail = emailInput.value.trim();
  const valid = /\S+@\S+\.\S+/.test(customerEmail);
  setEmailValidityUI(valid);
  enforcePayButtonState();
});

// --- Dropzone configuration ---
Dropzone.autoDiscover = false;

const dropzone = new Dropzone("#photoDropzone", {
  url: "#", // handled manually
  autoProcessQueue: false,
  maxFilesize: 10, // MB
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  addRemoveLinks: true,
  init: function () {
    this.on("addedfile", (file) => {
      uploadedFiles.push(file);
      enforcePayButtonState();
    });
    this.on("removedfile", (file) => {
      uploadedFiles = uploadedFiles.filter((f) => f !== file);
      enforcePayButtonState();
    });
  },
});

// --- Pay button handler ---
payButton.addEventListener("click", async () => {
  if (payButton.disabled) return;
  statusText.textContent = "Uploading and preparing checkout...";
  payButton.disabled = true;

  try {
    const formData = new FormData();
    formData.append("email", customerEmail);
    formData.append("pack", selectedPack);

    uploadedFiles.forEach((file) => formData.append("photos", file));

    const res = await fetch("/api/order", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    if (!res.ok) throw new Error(data.error || "Order creation failed.");

    window.location.href = data.checkout_url;
  } catch (err) {
    statusText.textContent = `Error: ${err.message}`;
  } finally {
    enforcePayButtonState();
  }
});
