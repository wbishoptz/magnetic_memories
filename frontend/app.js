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
const cropHelp         = document.getElementById("crop-help");
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

// ---- Helper: cropping status & UI ----
function getUncroppedFiles() {
  return myDropzone.files.filter((f) => !f._cropped);
}

function updateCropHelp() {
  const remaining = getUncroppedFiles().length;
  if (remaining > 0) {
    cropHelp.style.display = "block";
    cropHelp.textContent = `Cropping required for ${remaining} photo${remaining > 1 ? "s" : ""}.`;
    cropHelp.classList.remove("ok", "error");
    cropHelp.classList.add("warn");
  } else {
    cropHelp.style.display = "block";
    cropHelp.textContent = "All photos cropped — perfect!";
    cropHelp.classList.remove("warn", "error");
    cropHelp.classList.add("ok");
  }
}

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
  const allCropped = getUncroppedFiles().length === 0 && count > 0;
  payBtn.disabled = !(validEmail && count === requiredCount && allCropped);
}

function updatePhotoCount() {
  photoCountEl.textContent = String(myDropzone.files.length);
  updateCountHelp();
  updateCropHelp();
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

    // If we now exceed, prompt upgrade flow (handled by further adds), else nothing.
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
// Crop queue so multiple uploads open the cropper sequentially
const cropQueue = [];
let croppingActive = false;

function enqueueForCrop(file) {
  cropQueue.push(file);
  if (!croppingActive) processCropQueue();
}

async function processCropQueue() {
  if (croppingActive) return;
  croppingActive = true;

  while (cropQueue.length > 0) {
    const next = cropQueue.shift();
    if (!next || myDropzone.files.indexOf(next) === -1) continue; // already removed
    await openCropModalAndAwait(next); // force-crop or remove
  }

  croppingActive = false;
  updatePhotoCount();
}

myDropzone.on("addedfile", (file) => {
  addCropButton(file);
  showToast("Photo added", "ok");

  // Any new file requires crop
  file._cropped = false;
  enqueueForCrop(file);

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

  // Trim extras if still over (remove from end; removes from cropQueue implicitly)
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

    // 2) Upload files (cropped only — they all should be)
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

// Add “Crop” button to each preview (non-submitting)
function addCropButton(file) {
  const preview = file.previewElement;
  if (!preview || preview.querySelector(".dz-crop-btn")) return;

  const cropBtn = document.createElement("button");
  cropBtn.type = "button";
  cropBtn.textContent = "Crop";
  cropBtn.className = "dz-crop-btn";
  cropBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    // re-open for re-cropping
    enqueueForCrop(file);
    processCropQueue();
  });
  preview.appendChild(cropBtn);
}

// Crop modal elements
const cropModal   = document.getElementById("crop-modal");
const cropImg     = document.getElementById("crop-image");
const cropSave    = document.getElementById("crop-save");
const cropRemove  = document.getElementById("crop-remove");

// Promise wrapper so we can await each crop
function openCropModalAndAwait(file) {
  return new Promise((resolve) => {
    openCropModal(file, resolve);
  });
}

function openCropModal(file, done) {
  currentCropFile = file;

  const reader = new FileReader();
  reader.onload = (e) => {
    cropImg.src = e.target.result;
    cropModal.classList.remove("hidden");

    // Square crop, full image shown; user adjusts position/zoom
    cropperInstance = new Cropper(cropImg, {
      aspectRatio: 1,
      viewMode: 1,
      guides: true,
      autoCropArea: 1,
      movable: true,
      zoomable: true,
      background: false,
      modal: true,
      dragMode: 'move',
    });

    // Save Crop
    cropSave.onclick = (ev) => {
      ev.preventDefault();
      if (!cropperInstance || !currentCropFile) return;

      const canvas = cropperInstance.getCroppedCanvas({
        width: 1000,
        height: 1000,
        imageSmoothingQuality: "high",
      });

      canvas.toBlob((blob) => {
        if (!blob) return;

        const newName = currentCropFile.name.replace(/\.(heic|heif)$/i, ".jpg");
        const croppedFile = new File([blob], newName, { type: "image/jpeg" });
        croppedFile._cropped = true;

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
        if (done) done(); // continue queue
      }, "image/jpeg", 0.95);
    };

    // Remove photo (user declines to crop)
    cropRemove.onclick = (ev) => {
      ev.preventDefault();
      if (currentCropFile) {
        myDropzone.removeFile(currentCropFile);
      }
      if (cropperInstance) cropperInstance.destroy();
      cropperInstance = null;
      cropModal.classList.add("hidden");
      currentCropFile = null;
      updatePhotoCount();
      showToast("Photo removed", "warn");
      if (done) done(); // continue queue
    };
  };
  reader.readAsDataURL(file);
}
