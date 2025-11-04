// --- Simple state ---
let selectedPack = 3;
let requiredCount = 3;
let customerEmail = "";

const prices = { 3: 7, 6: 14, 9: 20, 12: 25, 15: 30 };

// --- Elements ---
const requiredCountEl = document.getElementById("required-count");
const emailInput = document.getElementById("email");
const payBtn = document.getElementById("payBtn");
const statusEl = document.getElementById("status");

// --- Pack selector wiring ---
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    selectedPack = parseInt(radio.value, 10);
    requiredCount = selectedPack;
    requiredCountEl.textContent = String(requiredCount);
    if (myDropzone) {
      myDropzone.options.maxFiles = requiredCount;
      enforcePayButtonState();
    }
  });
});

// --- Email input wiring ---
emailInput.addEventListener("input", () => {
  customerEmail = emailInput.value.trim();
  enforcePayButtonState();
});

// --- Dropzone setup ---
Dropzone.autoDiscover = false;
const dzElement = document.getElementById("mm-dropzone");

const myDropzone = new Dropzone(dzElement, {
  url: "/api/upload",            // will be overridden with ?orderId=...
  method: "post",
  autoProcessQueue: false,       // we upload manually
  uploadMultiple: false,
  parallelUploads: 2,
  maxFilesize: 10,               // MB
  maxFiles: requiredCount,
  acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
  createImageThumbnails: true,
  clickable: ["#mm-dropzone", "#fileInput"], // allow clicking anywhere
  dictDefaultMessage: "Drag & drop photos here, or click to choose",
});

myDropzone.on("addedfile", enforcePayButtonState);
myDropzone.on("removedfile", enforcePayButtonState);

// Enable Pay only when: valid email + exactly required file count
function enforcePayButtonState() {
  const fileCount = myDropzone.getAcceptedFiles().length;
  const validEmail = /\S+@\S+\.\S+/.test(customerEmail);
  const exactCount = fileCount === requiredCount;
  payBtn.disabled = !(validEmail && exactCount);
}

// --- Pay flow ---
payBtn.addEventListener("click", async () => {
  try {
    payBtn.disabled = true;
    statusEl.textContent = "Creating order…";

    // 1) Create draft order
    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: customerEmail, packSize: selectedPack }),
    });
    if (!orderRes.ok) throw new Error("Order creation failed");
    const { orderId } = await orderRes.json();

    // 2) Upload each file to /api/upload?orderId=...
    statusEl.textContent = "Uploading photos…";
    const files = myDropzone.getAcceptedFiles();

    for (const file of files) {
      const form = new FormData();
      form.append("file", file, file.name);

      const upRes = await fetch(`/api/upload?orderId=${encodeURIComponent(orderId)}`, {
        method: "POST",
        body: form,
      });
      if (!upRes.ok) throw new Error("An upload failed");
    }

    // 3) Create SumUp checkout
    statusEl.textContent = `Creating checkout (£${prices[selectedPack]})…`;
    const ckRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orderId }),
    });
    if (!ckRes.ok) throw new Error("Checkout creation failed");
    const { checkoutUrl } = await ckRes.json();

    // 4) Redirect to SumUp hosted checkout
    statusEl.textContent = "Redirecting to secure payment…";
    window.location.href = checkoutUrl;
  } catch (err) {
    console.error(err);
    statusEl.textContent = "Something went wrong. Please try again.";
    payBtn.disabled = false;
  }
});
