// --- Simple state ---
let selectedPack = 3;
let requiredCount = 3;
let previousPack = 3;
let customerEmail = "";
let emailTouched = false;

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };
const PACKS = [3, 6, 9, 12, 15];

// --- Elements ---
const requiredCountEl = document.getElementById("required-count");
const emailInput = document.getElementById("email");
const payBtn = document.getElementById("payBtn");
const statusEl = document.getElementById("status");
const photoCountEl = document.getElementById("photo-count");
const progressWrap = document.getElementById("upload-progress");
const progressBar = document.getElementById("upload-progress-bar");
const countHelp = document.getElementById("count-help");
const toastEl = document.getElementById("toast");

// Modal elements
const modal = document.getElementById("upgrade-modal");
const modalTitle = document.getElementById("upgrade-title");
const modalText = document.getElementById("upgrade-text");
const modalConfirm = document.getElementById("upgrade-confirm");
const modalKeep = document.getElementById("upgrade-keep");

let modalMode = "upgrade"; // 'upgrade' | 'downgrade'
let pendingTargetPack = null;

// --- Toast helper ---
let toastTimer = null;
function showToast(message, type = "ok") {
  toastEl.textContent = message;
  toastEl.classList.remove("ok", "warn", "error");
  toastEl.classList.add(type);
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
  }, 1800);
}

// --- Email validation UI helper ---
function setEmailValidityUI(isValid) {
  const emailEl = document.getElementById("email");
  const errEl = document.getElementById("emailError");

  if (!emailTouched) {
    emailEl.classList.remove("input-error");
    errEl.style.display = "none";
    return;
  }
  emailEl.classList.toggle("input-error", !isValid);
  errEl.style.display = isValid ? "none" : "block";
  emailEl.setAttribute("aria-invalid", String(!isValid));
}

// --- Dropzone instance ---
Dropzone.autoDiscover = false;
const dzElement = document.getElementById("mm-dropzone");

const myDropzone = new Dropzone(dzElement, {
  url: "/api/upload",
  method: "post",
  autoProcessQueue: false,
  uploadMultiple: false,
  parallelUploads: 2,
  maxFilesize: 10,
  maxFiles: requiredCount,
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  createImageThumbnails: true,
  addRemoveLinks: true,
  clickable: ["#mm-dropzone", "#fileInput"],
  dictDefaultMessage: "Drag & drop photos here, or click to choose",
  dictRemoveFile: "Remove",
});

// --- Helpers ---
function updateCountHelp() {
  const count = myDropzone.files.length;
  const need = requiredCount;
  countHelp.classList.remove("ok", "warn", "error");

  if (count === need) {
    countHelp.textContent = `Perfect — you have exactly ${need} photos.`;
    countHelp.classList.add("ok");
  } else if (count < need) {
    const remaining = need - count;
    countHelp.textContent = `You need exactly ${need} photos — add ${remaining} more.`;
    countHelp.classList.add("warn");
  } else {
    const extra = count - need;
    countHelp.textContent = `You need exactly ${need} photos — remove ${extra} photo${extra > 1 ? "s" : ""}.`;
    countHelp.classList.add("error");
  }
}

function updatePhotoCount() {
  const count = myDropzone.files.length;
  photoCountEl.textContent = String(count);
  updateCountHelp();
  enforcePayButtonState();
}

// Clear Dropzone's “max files” error state
function clearMaxFilesErrors() {
  myDropzone.files.forEach((file) => {
    const pe = file.previewElement;
    if (!pe) return;
    if (pe.classList.contains("dz-error")) {
      pe.classList.remove("dz-error");
      const msgEl = pe.querySelector("[data-dz-errormessage]");
      if (msgEl) msgEl.textContent = "";
    }
    if (file.status === Dropzone.ERROR) {
      file.status = Dropzone.ADDED;
      file.accepted = true;
    }
  });
  myDropzone.updateTotalUploadProgress();
  enforcePayButtonState();
}

// --- Pack selector wiring ---
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const newPack = parseInt(radio.value, 10);
    const currentCount = myDropzone ? myDropzone.files.length : 0;

    if (newPack < selectedPack && currentCount > newPack) {
      const prevRadio = document.querySelector(`input[name="pack"][value="${selectedPack}"]`);
      if (prevRadio) prevRadio.checked = true;

      modalMode = "downgrade";
      pendingTargetPack = newPack;
      const toRemove = currentCount - newPack;

      modalTitle.textContent = "Reduce pack size?";
      modalText.textContent =
        `You currently have ${currentCount} photos selected. ` +
        `If you move to a pack of ${newPack}, we’ll remove ${toRemove} photo(s). ` +
        `Do you want to continue?`;

      modalConfirm.textContent = `Downgrade to ${newPack}`;
      modalKeep.textContent = "Cancel";
      modal.classList.remove("hidden");
      return;
    }

    previousPack = selectedPack;
    selectedPack = newPack;
    requiredCount = newPack;
    requiredCountEl.textContent = String(requiredCount);
    myDropzone.options.maxFiles = requiredCount;
    clearMaxFilesErrors();
    updatePhotoCount();
    showToast(`Pack set to ${newPack} magnets`, "ok");
  });
});

// --- Email input wiring ---
emailInput.addEventListener("input", () => {
  emailTouched = true;
  customerEmail = emailInput.value.trim();
  const valid = /\S+@\S+\.\S+/.test(customerEmail);
  setEmailValidityUI(valid);
  enforcePayButtonState();
});
emailInput.addEventListener("blur", () => {
  emailTouched = true;
  const valid = /\S+@\S+\.\S+/.test(emailInput.value.trim());
  setEmailValidityUI(valid);
});
setEmailValidityUI(false);

// --- Dropzone events ---
myDropzone.on("addedfile", () => {
  updatePhotoCount();
  showToast("Photo added", "ok");
});

myDropzone.on("removedfile", () => {
  updatePhotoCount();
  showToast("Photo removed", "warn");
});

myDropzone.on("addedfiles", () => {
  const total = myDropzone.files.length;
  if (total > requiredCount) {
    const suggested = PACKS.find((p) => p >= total) ?? PACKS[PACKS.length - 1];
    modalMode = "upgrade";
    pendingTargetPack = suggested;

    modalTitle.textContent = "Add more magnets?";
    modalText.textContent =
      `You selected a pack of ${requiredCount}, but added ${total} photos. ` +
      `Upgrade to ${suggested} magnets for £${prices[suggested]}?`;

    modalConfirm.textContent = `Upgrade to ${suggested}`;
    modalKeep.textContent   = "Keep current & remove extras";
    modal.classList.remove("hidden");
  }
});

myDropzone.on("maxfilesexceeded", () => {
  const total = myDropzone.files.length;
  if (total > requiredCount) {
    const suggested = PACKS.find((p) => p >= total) ?? PACKS[PACKS.length - 1];
    modalMode = "upgrade";
    pendingTargetPack = suggested;

    modalTitle.textContent = "Add more magnets?";
    modalText.textContent =
      `You selected a pack of ${requiredCount}, but added ${total} photos. ` +
      `Upgrade to ${suggested} magnets for £${prices[suggested]}?`;

    modalConfirm.textContent = `Upgrade to ${suggested}`;
    modalKeep.textContent   = "Keep current & remove extras";
    modal.classList.remove("hidden");
  }
});

// Upload progress
myDropzone.on("totaluploadprogress", (progress) => {
  progressBar.style.width = `${progress}%`;
});

// --- Modal actions (upgrade & downgrade) ---
modalConfirm.addEventListener("click", () => {
  if (!pendingTargetPack) return;

  previousPack = selectedPack;
  selectedPack = pendingTargetPack;
  requiredCount = pendingTargetPack;
  requiredCountEl.textContent = String(requiredCount);

  const radio = document.querySelector(`input[name="pack"][value="${pendingTargetPack}"]`);
  if (radio) radio.checked = true;

  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }

  myDropzone.options.maxFiles = requiredCount;
  clearMaxFilesErrors();

  statusEl.textContent = "";
  modal.classList.add("hidden");
  pendingTargetPack = null;
  updatePhotoCount();
  showToast(`Pack set to ${selectedPack} magnets`, "ok");
});

modalKeep.addEventListener("click", () => {
  if (modalMode === "upgrade") {
    while (myDropzone.files.length > requiredCount) {
      myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
    }
    statusEl.textContent = `Limit reached: your pack allows ${requiredCount} photo(s).`;
    clearMaxFilesErrors();
    showToast("Kept current pack", "warn");
  } else if (modalMode === "downgrade") {
    const prevRadio = document.querySelector(`input[name="pack"][value="${selectedPack}"]`);
    if (prevRadio) prevRadio.checked = true;
    showToast("Cancelled downgrade", "warn");
  }

  modal.classList.add("hidden");
  pendingTargetPack = null;
  updatePhotoCount();
});

// Enable Pay only with valid email + exact count
function enforcePayButtonState() {
  const fileCount = myDropzone.files.length;
  const validEmail = /\S+@\S+\.\S+/.test(customerEmail);
  const exactCount = fileCount === requiredCount;
  payBtn.disabled = !(validEmail && exactCount);
}

// --- Pay flow ---
payBtn.addEventListener("click", async () => {
  try {
    payBtn.disabled = true;
    statusEl.textContent = "Creating order…";

    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: customerEmail, packSize: selectedPack }),
    });
    if (!orderRes.ok) {
      const txt = await orderRes.text().catch(() => "");
      throw new Error(txt || "Order creation failed");
    }
    const { orderId } = await orderRes.json();

    statusEl.textContent = "Uploading photos…";
    progressWrap.style.display = "block";
    progressWrap.setAttribute("aria-hidden", "false");
    progressBar.style.width = "0%";

    const files = myDropzone.files.slice();
    for (const file of files) {
      const form = new FormData();
      form.append("file", file, file.name);
      const upRes = await fetch(`/api/upload?orderId=${encodeURIComponent(orderId)}`, {
        method: "POST",
        body: form,
      });
      if (!upRes.ok) {
        const txt = await upRes.text().catch(() => "");
        throw new Error(txt || "Upload failed");
      }
    }

    progressBar.style.width = "100%";

    statusEl.textContent = `Creating checkout (£${prices[selectedPack]})…`;
    const ckRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });

    if (!ckRes.ok) {
      const txt = await ckRes.text().catch(() => "");
      throw new Error(txt || "Checkout creation failed");
    }

    const { checkoutUrl } = await ckRes.json();

    statusEl.textContent = "Redirecting to secure payment…";
    window.location.href = checkoutUrl;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err && err.message ? `Error: ${err.message}` : "Something went wrong. Please try again.";
    payBtn.disabled = false;
  } finally {
    setTimeout(() => {
      progressWrap.style.display = "none";
      progressWrap.setAttribute("aria-hidden", "true");
      progressBar.style.width = "0%";
    }, 500);
  }
});
