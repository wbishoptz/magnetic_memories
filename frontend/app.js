// ==========================
//  Magnetic Memories - App
// ==========================

// ---- State ----
let selectedPackSize = 3;
let selectedPackType = 'standard'; // 'standard' or 'big_picture'
let requiredCount = 3;
let previousRadioValue = "standard_3";
let customerEmail = "";
let customerPhone = "";
let emailTouched = false;
let phoneTouched = false;

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };
const PACKS = [3, 6, 9, 12, 15];

// ---- Elements ----
const requiredCountEl = document.getElementById("required-count");
const emailInput       = document.getElementById("email");
const phoneInput       = document.getElementById("phone");
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

let pendingTargetValue = null;

// --- Safety Net: Prevent accidental tab close ---
window.addEventListener("beforeunload", (e) => {
  if (myDropzone.files.length > 0 && !payBtn.disabled) {
    e.preventDefault();
    e.returnValue = "You have unsaved photos. Are you sure you want to leave?";
  }
});

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

// ---- Validation UI Helpers ----
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

function setPhoneValidityUI(isValid) {
  const errEl = document.getElementById("phoneError");
  if (!phoneTouched) {
    phoneInput.classList.remove("input-error");
    errEl.style.display = "none";
    return;
  }
  phoneInput.classList.toggle("input-error", !isValid);
  errEl.style.display = isValid ? "none" : "block";
  phoneInput.setAttribute("aria-invalid", String(!isValid));
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

// ---- Helper: Parsing Radio Values ----
function parsePackValue(val) {
  const parts = val.split('_'); // "standard_3" -> ["standard", "3"]
  return {
    type: parts[0] === 'big' ? 'big_picture' : 'standard',
    size: parseInt(parts[1], 10)
  };
}

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
    if (myDropzone.files.length === 0) {
      cropHelp.style.display = "none";
      return;
    }
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
    countHelp.textContent = `Perfect — you have exactly ${need} photo${need > 1 ? "s" : ""}.`;
    countHelp.classList.add("ok");
  } else if (count < need) {
    const remaining = need - count;
    countHelp.textContent = `You need exactly ${need} photo${need > 1 ? "s" : ""} — add ${remaining} more.`;
    countHelp.classList.add("warn");
  } else {
    const extra = count - need;
    countHelp.textContent = `You need exactly ${need} photo${need > 1 ? "s" : ""} — remove ${extra} photo${extra > 1 ? "s" : ""}.`;
    countHelp.classList.add("error");
  }
}

function enforcePayButtonState() {
  const count = myDropzone.files.length;
  const validEmail = /\S+@\S+\.\S+/.test(customerEmail);
  // Basic phone validation: at least 6 chars (handles international formats)
  const validPhone = customerPhone.length >= 6;
  const allCropped = getUncroppedFiles().length === 0 && count > 0;
  
  payBtn.disabled = !(validEmail && validPhone && count === requiredCount && allCropped);
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
    const newVal = radio.value;
    const { type, size } = parsePackValue(newVal);
    
    // Logic: If 'big_picture', required is ALWAYS 1. If 'standard', required is 'size'.
    const newRequired = (type === 'big_picture') ? 1 : size;
    const currentCount = myDropzone.files.length;

    // Guard: If we are switching to a pack that needs FEWER photos than we have
    if (newRequired < currentCount) {
      // Revert radio UI for now (until confirmed)
      const prevRadio = document.querySelector(`input[name="pack"][value="${previousRadioValue}"]`);
      if (prevRadio) prevRadio.checked = true;

      pendingTargetValue = newVal;
      const toRemove = currentCount - newRequired;

      modalTitle.textContent = "Too many photos selected";
      modalText.textContent =
        `You currently have ${currentCount} photos. ` +
        `The pack you selected only requires ${newRequired} photo${newRequired > 1 ? "s" : ""}. ` +
        `We need to remove ${toRemove} photo${toRemove > 1 ? "s" : ""} to continue.`;

      modalConfirm.textContent = `Remove extra photos`;
      modalKeep.textContent    = "Cancel";
      modal.classList.remove("hidden");
      return;
    }

    // Success update
    previousRadioValue = newVal;
    selectedPackSize = size;
    selectedPackType = type;
    requiredCount = newRequired;
    
    requiredCountEl.textContent = String(requiredCount);
    updatePhotoCount();
    
    const label = type === 'big_picture' ? `Big Picture (${size} magnets)` : `${size} magnets`;
    showToast(`Selected: ${label}`, "ok");
  });
});

// ---- Email & Phone wiring ----
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

phoneInput.addEventListener("input", () => {
  phoneTouched = true;
  // Strip non-numeric/plus chars for simpler validation if desired, 
  // but for now just trim whitespace.
  customerPhone = phoneInput.value.trim();
  setPhoneValidityUI(customerPhone.length >= 6);
  enforcePayButtonState();
});
phoneInput.addEventListener("blur", () => {
  phoneTouched = true;
  setPhoneValidityUI(phoneInput.value.trim().length >= 6);
});

setEmailValidityUI(false);
setPhoneValidityUI(false);

// ---- Add/Remove files ----
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
    await openCropModalAndAwait(next); 
  }

  croppingActive = false;
  updatePhotoCount();
}

myDropzone.on("addedfile", (file) => {
  addCropButton(file);
  showToast("Photo added", "ok");

  file._cropped = false;
  file._croppedBlob = null;
  enqueueForCrop(file);

  const total = myDropzone.files.length;
  // Use requiredCount instead of packSize, because Big Picture only needs 1
  if (total > requiredCount) {
    if (selectedPackType === 'standard') {
        const suggested = PACKS.find((p) => p >= total) ?? PACKS[PACKS.length - 1];
        // Suggest the standard pack
        pendingTargetValue = `standard_${suggested}`;
        
        modalTitle.textContent = "Add more magnets?";
        modalText.textContent =
          `You selected a pack of ${requiredCount}, but added ${total} photos. ` +
          `Upgrade to ${suggested} magnets for £${prices[suggested]}?`;

        modalConfirm.textContent = `Upgrade to ${suggested}`;
        modalKeep.textContent    = "Keep current & remove extras";
        modal.classList.remove("hidden");
    } else {
        // In Big Picture mode, just warn them
        modalTitle.textContent = "Limit Reached";
        modalText.textContent = `This Big Picture pack only uses 1 photo. We will remove the extra photo you just added.`;
        modalConfirm.textContent = "OK";
        modalKeep.style.display = "none"; // Hide cancel
        
        // Hack: store "keep" as pending to trigger removal logic
        pendingTargetValue = "KEEP_CURRENT"; 
        modal.classList.remove("hidden");
    }
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
  modalKeep.style.display = "inline-block"; // reset UI
  
  if (pendingTargetValue === "KEEP_CURRENT") {
      // Just trim extras
      while (myDropzone.files.length > requiredCount) {
        myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
      }
      modal.classList.add("hidden");
      return;
  }

  if (!pendingTargetValue) return;

  // Apply new selection
  const { type, size } = parsePackValue(pendingTargetValue);
  selectedPackType = type;
  selectedPackSize = size;
  requiredCount = (type === 'big_picture') ? 1 : size;
  
  previousRadioValue = pendingTargetValue;
  requiredCountEl.textContent = String(requiredCount);

  const radio = document.querySelector(`input[name="pack"][value="${pendingTargetValue}"]`);
  if (radio) radio.checked = true;

  // Trim extras if still over
  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }

  statusEl.textContent = "";
  modal.classList.add("hidden");
  pendingTargetValue = null;
  updatePhotoCount();
  
  const label = type === 'big_picture' ? `Big Picture (${size} magnets)` : `${size} magnets`;
  showToast(`Switched to ${label}`, "ok");
});

modalKeep.addEventListener("click", () => {
  modalKeep.style.display = "inline-block"; // reset UI
  
  // User cancelled the switch. Keep current pack settings.
  // BUT we must enforce the current limit (remove the photo they just tried to add).
  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }
  
  // Reset radio visually
  const prevRadio = document.querySelector(`input[name="pack"][value="${previousRadioValue}"]`);
  if (prevRadio) prevRadio.checked = true;

  showToast("Limit maintained", "warn");
  modal.classList.add("hidden");
  pendingTargetValue = null;
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
    
    const country = document.getElementById("shipping-country").value;
    const shippingCost = country === "GB" ? 5 : 0;
    const total = prices[selectedPackSize] + shippingCost;
    
    statusEl.textContent = "Creating order…";

    // 1) Create order (now sending Phone)
    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          email: customerEmail, 
          phone: customerPhone, // <--- SEND PHONE
          packSize: selectedPackSize,
          packType: selectedPackType
      }),
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
      const uploadBlob = file._croppedBlob || file;
      const uploadName = (file.name || "photo.jpg").replace(/\.(heic|heif)$/i, ".jpg");
      form.append("file", uploadBlob, uploadName);

      const upRes = await fetch(`/api/upload?orderId=${encodeURIComponent(orderId)}`, {
        method: "POST",
        body: form,
      });
      if (!upRes.ok) throw new Error((await upRes.text().catch(() => "")) || "Upload failed");
    }

    progressBar.style.width = "100%";

    // 3) Create checkout
    statusEl.textContent = `Creating checkout (£${total})…`;
    const ckRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        email: customerEmail,
        packSize: selectedPackSize,
        packType: selectedPackType,
        country: country
      }),
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

function addCropButton(_file) {
  const preview = _file.previewElement;
  if (!preview || preview.querySelector(".dz-crop-btn")) return;

  const cropBtn = document.createElement("button");
  cropBtn.type = "button";
  cropBtn.textContent = "Crop";
  cropBtn.className = "dz-crop-btn";
  cropBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const previewEl = e.currentTarget.closest(".dz-preview");
    const file = myDropzone.files.find((f) => f.previewElement === previewEl);
    if (file) {
      enqueueForCrop(file);
      processCropQueue();
    }
  });
  preview.appendChild(cropBtn);
}

// Crop modal elements
const cropModal   = document.getElementById("crop-modal");
const cropImg     = document.getElementById("crop-image");
const cropSave    = document.getElementById("crop-save");
const cropRemove  = document.getElementById("crop-remove");

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

    cropperInstance = new Cropper(cropImg, {
      aspectRatio: 1,
      viewMode: 1,
      guides: true,
      autoCropArea: 1,
      movable: true,
      zoomable: true,
      background: false,
      modal: true,
      dragMode: "move",
    });

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

        currentCropFile._cropped = true;
        currentCropFile._croppedBlob = blob;

        const preview = currentCropFile.previewElement;
        if (preview) {
          const imgEl = preview.querySelector("img");
          if (imgEl) imgEl.src = URL.createObjectURL(blob);
        }

        cropperInstance.destroy();
        cropperInstance = null;
        cropModal.classList.add("hidden");
        currentCropFile = null;

        updatePhotoCount();
        showToast("Crop saved", "ok");
        if (done) done();
      }, "image/jpeg", 0.95);
    };

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
      if (done) done();
    };
  };
  reader.readAsDataURL(file);
}