// --- Simple state ---
let selectedPack = 3;
let requiredCount = 3;
let customerEmail = "";
let emailTouched = false;

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

// --- Elements ---
const requiredCountEl = document.getElementById("required-count");
const emailInput = document.getElementById("email");
const payBtn = document.getElementById("payBtn");
const statusEl = document.getElementById("status");
const photoCountEl = document.getElementById("photo-count");
const progressWrap = document.getElementById("upload-progress");
const progressBar = document.getElementById("upload-progress-bar");

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

// --- Update the visible file counter (count immediately using all files) ---
function updatePhotoCount() {
  const count = myDropzone.files.length; // instant, no "acceptance" lag
  photoCountEl.textContent = String(count);
  // If user reduced pack size below current selection, remind them
  if (count > requiredCount) {
    statusEl.textContent = `You selected a pack of ${requiredCount}. Please remove ${count - requiredCount} photo(s).`;
  } else {
    // Only clear gentle messages; don't overwrite real errors during flow
    if (statusEl.textContent.startsWith("You selected a pack of")) {
      statusEl.textContent = "";
    }
  }
  enforcePayButtonState();
}

// --- Pack selector wiring ---
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    selectedPack = parseInt(radio.value, 10);
    requiredCount = selectedPack;
    requiredCountEl.textContent = String(requiredCount);
    if (myDropzone) {
      myDropzone.options.maxFiles = requiredCount;
      updatePhotoCount();
    }
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
setEmailValidityUI(false); // initial state

// --- Dropzone setup ---
Dropzone.autoDiscover = false;
const dzElement = document.getElementById("mm-dropzone");

const myDropzone = new Dropzone(dzElement, {
  url: "/api/upload",            // overridden per upload with ?orderId=...
  method: "post",
  autoProcessQueue: false,       // we upload manually after creating the order
  uploadMultiple: false,
  parallelUploads: 2,
  maxFilesize: 10,               // MB
  maxFiles: requiredCount,
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  createImageThumbnails: true,
  addRemoveLinks: true,          // <-- show "Remove" link on each thumbnail
  clickable: ["#mm-dropzone", "#fileInput"],
  dictDefaultMessage: "Drag & drop photos here, or click to choose",
  dictRemoveFile: "Remove",
});

// Keep count and button state in sync
myDropzone.on("addedfile", updatePhotoCount);
myDropzone.on("removedfile", updatePhotoCount);

// Hard limit: do not allow more than requiredCount
myDropzone.on("maxfilesexceeded", (file) => {
  // Reject the extra file and explain why
  myDropzone.removeFile(file);
  statusEl.textContent = `Limit reached: your pack allows ${requiredCount} photo(s).`;
});

// If a batch add would exceed, trim extra automatically
myDropzone.on("addedfiles", (files) => {
  // If after adding, we exceed, remove from the end
  while (myDropzone.files.length > requiredCount) {
    myDropzone.removeFile(myDropzone.files[myDropzone.files.length - 1]);
  }
  updatePhotoCount();
});

// Overall upload progress (0–100)
myDropzone.on("totaluploadprogress", (progress) => {
  progressBar.style.width = `${progress}%`;
});

// Enable Pay only when: valid email + exactly required file count
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

    // 1) Create draft order (JSON)
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

    // 2) Upload each file to /api/upload?orderId=...
    statusEl.textContent = "Uploading photos…";
    progressWrap.style.display = "block";
    progressWrap.setAttribute("aria-hidden", "false");
    progressBar.style.width = "0%";

    const files = myDropzone.files.slice(); // copy in case array mutates

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

    // 3) Create SumUp checkout
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

    // 4) Redirect to SumUp hosted checkout
    statusEl.textContent = "Redirecting to secure payment…";
    window.location.href = checkoutUrl;
  } catch (err) {
    console.error(err);
    statusEl.textContent =
      err && err.message ? `Error: ${err.message}` : "Something went wrong. Please try again.";
    payBtn.disabled = false;
  } finally {
    // Hide bar next time the user tries again
    setTimeout(() => {
      progressWrap.style.display = "none";
      progressWrap.setAttribute("aria-hidden", "true");
      progressBar.style.width = "0%";
    }, 500);
  }
});
