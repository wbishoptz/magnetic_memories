// ==========================
//  Magnetic Memories - App
// ==========================

// ---- State ----
let selectedPack = 3;
let requiredCount = 3;
let previousPack = 3;
let customerEmail = "";
let emailTouched = false;

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };
const PACKS = [3, 6, 9, 12, 15];

// ---- Elements ----
const requiredCountEl = document.getElementById("required-count");
const emailInput       = document.getElementById("email");
const payBtn           = document.getElementById("payBtn");
const statusEl         = document.getElementById("status");
const photoCountEl     = document.getElementById("photo-count");
const progressWrap     = document.getElementById("upload-progress");
const progressBar      = document.getElementById("upload-progress-bar");
const countHelp        = document.getElementById("count-help");
const toastEl          = document.getElementById("toast");

// Upgrade/Downgrade modal
const modal        = document.getElementById("upgrade-modal");
const modalTitle   = document.getElementById("upgrade-title");
const modalText    = document.getElementById("upgrade-text");
const modalConfirm = document.getElementById("upgrade-confirm");
const modalKeep    = document.getElementById("upgrade-keep");

let modalMode = "upgrade"; // 'upgrade' | 'downgrade'
let pendingTargetPack = null;

// ---- Toasts ----
let toastTimer = null;
function showToast(message, type = "ok") {
  toastEl.textContent = message;
  toastEl.classList.remove("ok", "warn", "error", "show");
  toastEl.classList.add(type);
  // trigger transition
  requestAnimationFrame(() => toastEl.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 1800);
}

// ---- Email validation UI ----
function setEmailValidityUI(isValid) {
  const errEl = document.getElementById("emailError");
  if (!emailTouched) {
    emailInput.classList.remove("input-error");
    errEl.style.display = "none";
    return;
  }
  emailInput.classList.toggle("input-error", !isValid);
  errEl.style.display = isValid ? "none" : "block";
  emailInput.setAttribute("aria-invalid", String(!isValid));
}

// ---- Dropzone ----
// We don't set maxFiles here; we enforce limits ourselves to avoid DZ's error UI.
Dropzone.autoDiscover = false;
const dzElement = document.getElementById("mm-dropzone");

const myDropzone = new Dropzone(dzElement, {
  url: "/api/upload",
  method: "post",
  autoProcessQueue: false,
  uploadMultiple: false,
  parallelUploads: 2,
  maxFilesize: 10, // MB
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  createImageThumbnails: true,
  addRemoveLinks: true,
  clickable: ["#mm-dropzone", "#fileInput"],
  dictDefaultMessage: "Drag & drop photos here, or click to choose",
  dictRemoveFile: "Remove",
});

// ---- Helpers ----
function updateCountHelp() {
  const count = myDropzone.files.length;
  const need  = requiredCount;
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

function enforcePayButtonState() {
  const count = myDropzone.files.length;
  const validEmail = /\S+@\S+\.\S+/.test(customerEmail);
  payBtn.disabled = !(validEmail && count === requiredCount);
}

function updatePhotoCount() {
  photoCountEl.textContent = String(myDropzone.files.length);
  updateCountHelp();
  enforcePayButtonState();
}

// ---- Pack selector (with downgrade guard) ----
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const newPack = parseInt(radio.value, 10);
    const currentCount = myDropzone.files.length;

    if (newPack < selectedPack && currentCount > newPack) {
      // Revert radio UI for now (until confirmed)
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
      modalKeep.textContent    = "Cancel";
      modal.classList.remove("hidden");
      return;
    }

    // Upgrade or OK downgrade
    previousPack  = selectedPack;
    selectedPack  = newPack;
    requiredCount = newPack;
    requiredCountEl.textContent = String(requiredCount);
    updatePhotoCount();
    showToast(`Pack set to ${newPack} magnets`, "ok");
  });
});

// ---- Email wiring ----
emailInput.addEventListener("input", () => {
  emailTouched  = true;
  customerEmail = emailInput.value.trim();
  setEmailValidityUI(/\S+@\S+\.\S+/.test(customerEmail));
  enforcePayButtonState();
});
emailInput.addEventListener("blur", () => {
  emailTouched  = true;
  setEmailValidityUI(/\S+@\S+\.\S+/.test(emailInput.value.trim()));
});
setEmailValidityUI(false);

// ---- Add/Remove files ----
myDropzone.on("addedfile", (file) => {
  addCropButton(file);
  showToast("Photo added", "ok");

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
    modalKeep.textContent    = "Keep current & remove extras";
    modal.classList.remove("hidden");
  } else {
    updatePhotoCount();
  }
});

myDropzone.on("removedfile", () => {
  showToast("Photo removed", "warn");
  updatePhotoCount();
});

// ---- Upgrade/Downgrade modal actions ----
modalConfirm.addEventListener("click", () => {
  if (!pendingTargetPack) return;

  previousPack  = selectedPack;
  selectedPack  = pendingTargetPack;
  requiredCount = pendingTargetPack;
  requiredCountEl.textContent = String(requiredCount);

  // Reflect radio
  const radio = document.querySelector(`input[name="pack"][value="${pendingTargetPack}"]`);
  if (radio) radio.checked = true;

  // Trim extras if still over
  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }

  statusEl.textContent = "";
  modal.classList.add("hidden");
  pendingTargetPack = null;
  updatePhotoCount();
  showToast(`Pack set to ${selectedPack} magnets`, "ok");
});

modalKeep.addEventListener("click", () => {
  if (modalMode === "upgrade") {
    // Keep current pack—trim extras back down
    while (myDropzone.files.length > requiredCount) {
      myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
    }
    statusEl.textContent = `Limit reached: your pack allows ${requiredCount} photo(s).`;
    showToast("Kept current pack", "warn");
  } else if (modalMode === "downgrade") {
    // Cancel downgrade; recheck previous radio
    const prevRadio = document.querySelector(`input[name="pack"][value="${selectedPack}"]`);
    if (prevRadio) prevRadio.checked = true;
    showToast("Cancelled downgrade", "warn");
  }
  modal.classList.add("hidden");
  pendingTargetPack = null;
  updatePhotoCount();
});

// ---- Upload progress ----
myDropzone.on("totaluploadprogress", (progress) => {
  progressBar.style.width = `${progress}%`;
});

// ---- Pay flow ----
payBtn.addEventListener("click", async () => {
  try {
    payBtn.disabled = true;
    statusEl.textContent = "Creating order…";

    // 1) Create order
    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: customerEmail, packSize: selectedPack }),
    });
    if (!orderRes.ok) throw new Error((await orderRes.text().catch(() => "")) || "Order creation failed");
    const { orderId } = await orderRes.json();

    // 2) Upload files
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
      if (!upRes.ok) throw new Error((await upRes.text().catch(() => "")) || "Upload failed");
    }

    progressBar.style.width = "100%";

    // 3) Create checkout
    statusEl.textContent = `Creating checkout (£${prices[selectedPack]})…`;
    const ckRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    if (!ckRes.ok) throw new Error((await ckRes.text().catch(() => "")) || "Checkout creation failed");

    const { checkoutUrl } = await ckRes.json();

    statusEl.textContent = "Redirecting to secure payment…";
    window.location.href = checkoutUrl;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err?.message || "Something went wrong. Please try again.";
    payBtn.disabled = false;
  } finally {
    setTimeout(() => {
      progressWrap.style.display = "none";
      progressWrap.setAttribute("aria-hidden", "true");
      progressBar.style.width = "0%";
    }, 500);
  }
});


// =====================
//  Cropper Integration
// =====================
let currentCropFile = null;
let cropperInstance = null;

// Add “Crop” button to each preview (ensure it's not a submit)
function addCropButton(file) {
  const preview = file.previewElement;
  if (!preview || preview.querySelector(".dz-crop-btn")) return;

  const cropBtn = document.createElement("button");
  cropBtn.type = "button";            // <-- important: prevent form submit
  cropBtn.textContent = "Crop";
  cropBtn.className = "dz-crop-btn";
  cropBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openCropModal(file);
  });
  preview.appendChild(cropBtn);
}

// Crop modal elements
const cropModal  = document.getElementById("crop-modal");
const cropImg    = document.getElementById("crop-image");
const cropSave   = document.getElementById("crop-save");
const cropCancel = document.getElementById("crop-cancel");

function openCropModal(file) {
  currentCropFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    cropImg.src = e.target.result;
    cropModal.classList.remove("hidden");
    cropperInstance = new Cropper(cropImg, {
      aspectRatio: 1,         // 50x50mm = 1:1
      viewMode: 1,
      guides: true,
      autoCropArea: 1,
      movable: true,
      zoomable: true,
      background: false,
      modal: true,
    });
  };
  reader.readAsDataURL(file);
}

cropSave.addEventListener("click", (e) => {
  e.preventDefault();
  if (!cropperInstance || !currentCropFile) return;

  const canvas = cropperInstance.getCroppedCanvas({
    width: 1000,
    height: 1000,
    imageSmoothingQuality: "high",
  });

  canvas.toBlob((blob) => {
    if (!blob) return;

    // Replace original with cropped JPEG (ensures consistent format for print)
    const newName = currentCropFile.name.replace(/\.(heic|heif)$/i, ".jpg");
    const croppedFile = new File([blob], newName, { type: "image/jpeg" });
    croppedFile.cropped = true;

    const idx = myDropzone.files.indexOf(currentCropFile);
    if (idx >= 0) {
      myDropzone.files[idx] = croppedFile;
      const preview = currentCropFile.previewElement;
      if (preview) {
        const imgEl = preview.querySelector("img");
        if (imgEl) imgEl.src = URL.createObjectURL(blob);
      }
    }

    cropperInstance.destroy();
    cropperInstance = null;
    cropModal.classList.add("hidden");
    currentCropFile = null;
    updatePhotoCount();
    showToast("Crop saved", "ok");
  }, "image/jpeg", 0.95);
});

cropCancel.addEventListener("click", (e) => {
  e.preventDefault();
  if (cropperInstance) cropperInstance.destroy();
  cropperInstance = null;
  cropModal.classList.add("hidden");
  currentCropFile = null;
});
