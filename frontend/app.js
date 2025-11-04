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
const dzElement = document.getElementById("mm-dropzone");
const fileInput = document.getElementById("fileInput");

// make the box focusable/clickable no matter what
dzElement.setAttribute("tabindex", "0");
dzElement.style.outline = "none";

// --- Pack selector wiring ---
document.querySelectorAll('input[name="pack"]').forEach((radio) => {
  radio.addEventListener("change", () => {
    selectedPack = parseInt(radio.value, 10);
    requiredCount = selectedPack;
    requiredCountEl.textContent = String(requiredCount);
    if (window.myDropzone) {
      window.myDropzone.options.maxFiles = requiredCount;
      enforcePayButtonState();
    } else {
      enforcePayButtonState();
    }
  });
});

// --- Email input wiring ---
emailInput.addEventListener("input", () => {
  customerEmail = emailInput.value.trim();
  enforcePayButtonState();
});

// --- Fallback thumbnail list (if Dropzone not present) ---
const fallbackFiles = []; // File objects when Dropzone isn't available

function renderFallbackThumbs() {
  // create a lightweight preview using object URLs
  // remove any existing previews
  dzElement.querySelectorAll(".mm-fb-thumb").forEach((el) => el.remove());
  fallbackFiles.forEach((file) => {
    const wrap = document.createElement("div");
    wrap.className = "mm-fb-thumb";
    wrap.style.margin = "6px";
    const img = document.createElement("img");
    img.style.maxHeight = "80px";
    img.style.borderRadius = "6px";
    img.src = URL.createObjectURL(file);
    wrap.appendChild(img);
    dzElement.appendChild(wrap);
  });
}

// --- Enable Pay only when: valid email + exactly required file count
function enforcePayButtonState() {
  const validEmail = /\S+@\S+\.\S+/.test(emailInput.value.trim());
  let count = 0;
  if (window.myDropzone) {
    count = window.myDropzone.getAcceptedFiles().length;
  } else {
    count = fallbackFiles.length;
  }
  const exactCount = count === requiredCount;
  payBtn.disabled = !(validEmail && exactCount);
}

// --- Try to initialize Dropzone ---
let usingFallback = false;

(function initUploader() {
  try {
    if (typeof Dropzone !== "undefined") {
      Dropzone.autoDiscover = false;
      window.myDropzone = new Dropzone(dzElement, {
        url: "/api/upload", // overridden with ?orderId=... on submit
        method: "post",
        autoProcessQueue: false,
        uploadMultiple: false,
        parallelUploads: 2,
        maxFilesize: 10, // MB
        maxFiles: requiredCount,
        acceptedFiles: "image/jpeg,image/png,image/heic,image/heif",
        createImageThumbnails: true,
        clickable: ["#mm-dropzone", "#fileInput"],
        dictDefaultMessage: "Drag & drop photos here, or click to choose",
      });
      window.myDropzone.on("addedfile", enforcePayButtonState);
      window.myDropzone.on("removedfile", enforcePayButtonState);
    } else {
      usingFallback = true;
    }
  } catch (e) {
    usingFallback = true;
  }

  // Fallback: open file picker on click, and show simple previews
  if (usingFallback) {
    dzElement.addEventListener("click", () => fileInput.click());
    dzElement.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") fileInput.click();
    });
    fileInput.addEventListener("change", () => {
      // enforce count
      const files = Array.from(fileInput.files || []);
      fallbackFiles.length = 0;
      for (const f of files.slice(0, requiredCount)) fallbackFiles.push(f);
      renderFallbackThumbs();
      enforcePayButtonState();
    });
  }
})();

// --- Pay flow ---
payBtn.addEventListener("click", async () => {
  try {
    payBtn.disabled = true;
    statusEl.textContent = "Creating order…";

    // 1) Create draft order
    const orderRes = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: emailInput.value.trim(), packSize: selectedPack }),
    });
    if (!orderRes.ok) throw new Error("Order creation failed");
    const { orderId } = await orderRes.json();

    // 2) Upload each file to /api/upload?orderId=...
    statusEl.textContent = "Uploading photos…";

    if (window.myDropzone) {
      const files = window.myDropzone.getAcceptedFiles();
      for (const file of files) {
        const form = new FormData();
        form.append("file", file, file.name);
        const upRes = await fetch(`/api/upload?orderId=${encodeURIComponent(orderId)}`, {
          method: "POST",
          body: form,
        });
        if (!upRes.ok) throw new Error("An upload failed");
      }
    } else {
      // fallback upload
      for (const file of fallbackFiles) {
        const form = new FormData();
        form.append("file", file, file.name);
        const upRes = await fetch(`/api/upload?orderId=${encodeURIComponent(orderId)}`, {
          method: "POST",
          body: form,
        });
        if (!upRes.ok) throw new Error("An upload failed");
      }
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
