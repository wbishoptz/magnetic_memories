// ==========================
//  Magnetic Memories - App
// ==========================

// ---- State ----
let currentOrderId = null; 
let isRecovery = false;
let selectedPackSize = 3;
let selectedPackType = 'standard'; 
let requiredCount = 3;
let previousRadioValue = "standard_3";
let customerEmail = "";
let customerPhone = "";
let emailTouched = false;
let phoneTouched = false;
let voucherApplied = 0;
let voucherCode = "";
let socialPermission = null; // null, true, or false
let selectedShipping = null; // NEW: null, 'GI_COLLECT', 'GI_DELIVER', 'GB'

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };
const PACKS = [3, 6, 9, 12, 15];

// ---- Elements ----
const requiredCountEl  = document.getElementById("required-count");
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
const uploadMetaEl     = document.querySelector(".upload-meta"); 
const uploadSection    = document.getElementById("upload-section");

// Radio Groups
const socialRadios     = document.querySelectorAll('input[name="socials"]');
const shippingRadios   = document.querySelectorAll('input[name="shipping"]');
const socialWrapper    = document.getElementById("social-wrapper");
const shippingWrapper  = document.getElementById("shipping-wrapper");

const promoInput       = document.getElementById("promo-code");
const promoBtn         = document.getElementById("apply-promo");
const promoMsg         = document.getElementById("promo-msg");

// Upgrade/Downgrade modal
const modal        = document.getElementById("upgrade-modal");
const modalTitle   = document.getElementById("upgrade-title");
const modalText    = document.getElementById("upgrade-text");
const modalConfirm = document.getElementById("upgrade-confirm");
const modalKeep    = document.getElementById("upgrade-keep");

// WhatsApp Modal Elements
const waModal = document.getElementById("whatsapp-modal");
const waClose = document.getElementById("wa-close");

let pendingTargetValue = null;

// --- Initialize Resume Logic ---
document.addEventListener("DOMContentLoaded", async () => {
    const urlParams = new URLSearchParams(window.location.search);
    const resumeId = urlParams.get('resumeOrder');
    
    if (resumeId) {
        currentOrderId = resumeId;
        isRecovery = true; 
        showToast("Restoring your cart...", "ok");
        try {
            const res = await fetch(`/api/order?orderId=${resumeId}`);
            if (res.ok) {
                const data = await res.json();
                if (data.status === 'draft' || data.status === 'abandoned') {
                    // Restore Fields
                    if (data.email) {
                        emailInput.value = data.email;
                        customerEmail = data.email;
                        emailTouched = true;
                        setEmailValidityUI(true);
                    }
                    if (data.phone) {
                        phoneInput.value = data.phone;
                        customerPhone = data.phone;
                        phoneTouched = true;
                        setPhoneValidityUI(true);
                    }
                    
                    // Restore Pack Selection
                    let radioVal = "";
                    if (data.packSize && String(data.packSize).startsWith("voucher_")) {
                        radioVal = data.packSize;
                    } else {
                        radioVal = `standard_${data.packSize}`;
                    }
                    const radio = document.querySelector(`input[name="pack"][value="${radioVal}"]`);
                    if (radio) {
                        radio.checked = true;
                        radio.dispatchEvent(new Event("change")); 
                    }

                    // Restore Social Selection
                    if (typeof data.socialPermission === 'boolean') {
                        const val = data.socialPermission ? 'yes' : 'no';
                        const socRadio = document.querySelector(`input[name="socials"][value="${val}"]`);
                        if (socRadio) {
                           socRadio.checked = true;
                           socialPermission = data.socialPermission;
                        }
                    }

                    // Restore Shipping Selection
                    if (data.shippingMethod) {
                        const shipRadio = document.querySelector(`input[name="shipping"][value="${data.shippingMethod}"]`);
                        if (shipRadio) {
                            shipRadio.checked = true;
                            selectedShipping = data.shippingMethod;
                        }
                    }

                    showToast("Cart restored!", "ok");
                }
            }
        } catch (e) {
            console.error("Failed to restore", e);
        }
    } else {
        if (!currentOrderId) currentOrderId = crypto.randomUUID();
    }
});

// --- WhatsApp Modal Handler ---
if (waClose) {
    waClose.addEventListener("click", () => waModal.classList.add("hidden"));
}

// --- ABANDONED CART SAVER ---
async function saveCart() {
    if (!currentOrderId || !customerEmail) return;
    
    try {
        await fetch("/api/save-cart", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                orderId: currentOrderId,
                email: customerEmail,
                phone: customerPhone,
                packSize: (selectedPackType === 'voucher') ? `voucher_${selectedPackSize}` : selectedPackSize,
                packType: selectedPackType,
                isRecovery: isRecovery,
                socialPermission: socialPermission,
                shippingMethod: selectedShipping
            })
        });
    } catch(e) {}
}

// --- Safety Net ---
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

// ---- Validation Logic ----
function isEmailValid() {
  return /\S+@\S+\.\S+/.test(customerEmail);
}
function isPhoneValid() {
  return customerPhone.length >= 6;
}
function isCountValid() {
  if (selectedPackType === 'voucher') return true; 
  return myDropzone.files.length === requiredCount;
}
function isAllCropped() {
  if (selectedPackType === 'voucher') return true;
  return getUncroppedFiles().length === 0 && myDropzone.files.length > 0;
}
function isSocialSelected() {
    return socialPermission !== null;
}
function isShippingSelected() {
    return selectedShipping !== null;
}

// ---- UI Feedback (Jiggle) ----
function shakeElement(el) {
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), 500);
}

// ---- UI State Update ----
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

function updatePayButtonAppearance() {
  const ready = isEmailValid() && isPhoneValid() && isCountValid() && isAllCropped() && isSocialSelected() && isShippingSelected();
  if (ready) {
    payBtn.classList.remove("disabled-look");
    payBtn.textContent = "Pay securely";
  } else {
    payBtn.classList.add("disabled-look");
  }
}

// ---- Helper: Show/Hide Elements ----
function updateVisibility() {
    if (selectedPackType === 'voucher') {
        uploadSection.style.display = "none";
    } else {
        uploadSection.style.display = "block";
    }
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
  maxFilesize: 95, 
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  createImageThumbnails: true,
  addRemoveLinks: true,
  clickable: ["#mm-dropzone", "#fileInput"],
  dictDefaultMessage: "Drag & drop photos here, or click to choose",
  dictRemoveFile: "Remove",
});

// Handle Files Too Big
myDropzone.on("error", (file, message) => {
  if (typeof message === "string" && message.includes("too big")) {
    myDropzone.removeFile(file); 
    waModal.classList.remove("hidden");
  }
});

function parsePackValue(val) {
  const parts = val.split('_'); 
  if (parts[0] === 'voucher') {
      return { type: 'voucher', size: parseInt(parts[1], 10) };
  }
  return { type: 'standard', size: parseInt(parts[1], 10) };
}

function getUncroppedFiles() {
  return myDropzone.files.filter((f) => !f._cropped);
}

function updateCropHelp() {
  if (selectedPackType === 'voucher') return;
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
  if (selectedPackType === 'voucher') return;
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

function updatePhotoCount() {
  photoCountEl.textContent = String(myDropzone.files.length);
  updateCountHelp();
  updateCropHelp();
  updatePayButtonAppearance();
}

// ---- Promo Code Logic ----
promoBtn.addEventListener("click", async () => {
    const code = promoInput.value.trim();
    if (!code) return;
    
    promoBtn.textContent = "...";
    try {
        const res = await fetch("/api/voucher-check", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code })
        });
        const data = await res.json();
        
        if (data.valid) {
            voucherApplied = data.value;
            voucherCode = data.code;
            promoMsg.style.color = "#66d19e";
            promoMsg.textContent = `Voucher applied! -£${data.value}`;
            promoMsg.style.display = "block";
            promoInput.disabled = true;
            promoBtn.style.display = "none";
            showToast(`Discount applied: -£${data.value}`, "ok");
        } else {
            promoMsg.style.color = "#ff6666";
            promoMsg.textContent = data.error || "Invalid code";
            promoMsg.style.display = "block";
        }
    } catch (e) {
        console.error(e);
        promoMsg.textContent = "Error checking code";
    } finally {
        promoBtn.textContent = "Apply";
    }
});

// ---- Pack selector ----
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    const newVal = radio.value;
    const { type, size } = parsePackValue(newVal);
    
    let newRequired = size;
    if (type === 'voucher') newRequired = 0;

    const currentCount = myDropzone.files.length;

    if (type !== 'voucher' && newRequired < currentCount) {
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

    previousRadioValue = newVal;
    selectedPackSize = size; 
    selectedPackType = type;
    requiredCount = newRequired;
    
    requiredCountEl.textContent = String(requiredCount);
    
    updateVisibility(); 
    updatePhotoCount();
    saveCart(); 

    let label = `${size} magnets`;
    if (type === 'voucher') label = `£${size} Gift Voucher`;
    
    showToast(`Selected: ${label}`, "ok");
  });
});

// ---- Social Media Listeners ----
socialRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            socialPermission = (radio.value === 'yes');
            document.getElementById('socialError').style.display = 'none';
            updatePayButtonAppearance();
            saveCart();
        }
    });
});

// ---- Shipping Listeners ----
shippingRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        if (radio.checked) {
            selectedShipping = radio.value;
            document.getElementById('shippingError').style.display = 'none';
            updatePayButtonAppearance();
            saveCart();
        }
    });
});

// ---- Inputs ----
emailInput.addEventListener("blur", () => {
  emailTouched  = true;
  customerEmail = emailInput.value.trim();
  setEmailValidityUI(isEmailValid());
  saveCart(); 
});

phoneInput.addEventListener("blur", () => {
  phoneTouched = true;
  customerPhone = phoneInput.value.trim();
  setPhoneValidityUI(isPhoneValid());
  saveCart();
});

setEmailValidityUI(false);
setPhoneValidityUI(false);

// ---- Dropzone Logic ----
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
    if (!next || myDropzone.files.indexOf(next) === -1) continue; 
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
  
  if (selectedPackType !== 'voucher' && total > requiredCount) {
    // Only Standard type exists now
    const suggested = PACKS.find((p) => p >= total) ?? PACKS[PACKS.length - 1];
    pendingTargetValue = `standard_${suggested}`;
    
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

// ---- Upgrade/Downgrade ----
modalConfirm.addEventListener("click", () => {
  modalKeep.style.display = "inline-block";
  
  if (!pendingTargetValue) return;

  const { type, size } = parsePackValue(pendingTargetValue);
  selectedPackType = type;
  selectedPackSize = size;
  requiredCount = size;
  if (type === 'voucher') requiredCount = 0;
  
  previousRadioValue = pendingTargetValue;
  requiredCountEl.textContent = String(requiredCount);

  const radio = document.querySelector(`input[name="pack"][value="${pendingTargetValue}"]`);
  if (radio) radio.checked = true;

  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }

  statusEl.textContent = "";
  modal.classList.add("hidden");
  pendingTargetValue = null;
  updateVisibility();
  updatePhotoCount();
  saveCart(); 
  
  let label = `${size} magnets`;
  if (type === 'voucher') label = `£${size} Gift Voucher`;
  showToast(`Switched to ${label}`, "ok");
});

modalKeep.addEventListener("click", () => {
  modalKeep.style.display = "inline-block";
  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }
  const prevRadio = document.querySelector(`input[name="pack"][value="${previousRadioValue}"]`);
  if (prevRadio) prevRadio.checked = true;

  showToast("Limit maintained", "warn");
  modal.classList.add("hidden");
  pendingTargetValue = null;
  updatePhotoCount();
});

myDropzone.on("totaluploadprogress", (progress) => {
  progressBar.style.width = `${progress}%`;
});

// ---- PAY BUTTON CLICK (Smart Validation) ----
payBtn.addEventListener("click", async () => {
  if (!isEmailValid()) {
    emailTouched = true;
    setEmailValidityUI(false);
    shakeElement(emailInput);
    showToast("Please enter a valid email", "error");
    return;
  }

  if (!isPhoneValid()) {
    phoneTouched = true;
    setPhoneValidityUI(false);
    shakeElement(phoneInput);
    showToast("Please enter a phone number", "error");
    return;
  }

  // New Shipping Validation
  if (!isShippingSelected()) {
      shakeElement(shippingWrapper);
      document.getElementById('shippingError').style.display = 'block';
      showToast("Please select a shipping method", "error");
      return;
  }

  // New Social Validation
  if (!isSocialSelected()) {
      shakeElement(socialWrapper);
      document.getElementById('socialError').style.display = 'block';
      showToast("Please select a social media option", "error");
      return;
  }

  if (!isCountValid()) {
    shakeElement(uploadMetaEl);
    showToast(`You need exactly ${requiredCount} photo${requiredCount>1?'s':''}`, "error");
    return;
  }

  if (!isAllCropped()) {
    shakeElement(cropHelp);
    showToast("Please crop all photos", "error");
    return;
  }

  try {
    payBtn.disabled = true;
    payBtn.textContent = "Processing...";
    
    // GET SHIPPING SELECTION
    const country = document.querySelector('input[name="shipping"]:checked').value;
    
    const packSizePayload = (selectedPackType === 'voucher') 
        ? `voucher_${selectedPackSize}` 
        : selectedPackSize;

    statusEl.textContent = "Creating order…";

    // 1. SAVE ORDER (Includes shippingMethod for Admin)
    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
          orderId: currentOrderId, 
          email: customerEmail, 
          phone: customerPhone,
          packSize: packSizePayload, 
          packType: selectedPackType,
          socialPermission: socialPermission,
          shippingMethod: country 
      }),
    });
    
    if (!orderRes.ok) throw new Error((await orderRes.text().catch(() => "")) || "Order creation failed");
    const { orderId } = await orderRes.json();
    currentOrderId = orderId; 

    // 2. UPLOAD PHOTOS (Only if not voucher)
    if (selectedPackType !== 'voucher') {
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
    }

    // 3. CREATE CHECKOUT (Passes country for Stripe Logic)
    statusEl.textContent = `Creating checkout…`;
    const ckRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        orderId,
        email: customerEmail,
        packSize: packSizePayload, 
        packType: selectedPackType,
        country: country, // <--- UPDATED FROM RADIO
        voucherCode: voucherCode
      }),
    });
    if (!ckRes.ok) throw new Error((await ckRes.text().catch(() => "")) || "Checkout creation failed");

    const { checkoutUrl } = await ckRes.json();

    statusEl.textContent = "Redirecting...";
    window.location.href = checkoutUrl;
  } catch (err) {
    console.error(err);
    statusEl.textContent = err?.message || "Something went wrong. Please try again.";
    payBtn.disabled = false;
    payBtn.textContent = "Pay securely";
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

  // Always square aspect ratio (1:1) now
  let ratio = 1; 

  const reader = new FileReader();
  reader.onload = (e) => {
    cropImg.src = e.target.result;
    cropModal.classList.remove("hidden");

    cropperInstance = new Cropper(cropImg, {
      aspectRatio: ratio,
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
        maxWidth: 3000,
        maxHeight: 3000,
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

updatePayButtonAppearance();
updateVisibility();