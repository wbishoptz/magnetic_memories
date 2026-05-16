// Magnetic Memories — Basket
// Self-contained module. Loads on all product pages.
// Feature-flagged: does nothing if basket is disabled in admin.

(function () {
  'use strict';

  const STORAGE_KEY = 'mm_basket_v1';
  const PRIMARY = '#59c9a5';      // teal, used for success states across the site
  const PRIMARY_DARK = '#45b08a';

  let state = { items: [] };
  let basketEnabled = false;
  let panelOpen = false;
  let inCheckout = false;
  let voucherApplied = 0;
  let voucherCode = '';

  // ─── State management ──────────────────────────────────────────────────────

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { items: [] }; }
    catch { return { items: [] }; }
  }

  function saveState() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {}
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  function add(orderId, label, price) {
    // Prevent duplicate entries for the same orderId
    state.items = state.items.filter(i => i.orderId !== orderId);
    state.items.push({ orderId, label, price: Number(price) });
    saveState();
    voucherApplied = 0;
    voucherCode = '';
    inCheckout = false;
    updateBadge();
    openPanel();
  }

  function remove(orderId) {
    state.items = state.items.filter(i => i.orderId !== orderId);
    saveState();
    if (state.items.length === 0) inCheckout = false;
    updateBadge();
    renderContent();
  }

  function clear() {
    state.items = [];
    voucherApplied = 0;
    voucherCode = '';
    inCheckout = false;
    saveState();
    updateBadge();
    renderContent();
  }

  // ─── Initialise ────────────────────────────────────────────────────────────

  async function init() {
    state = loadState();
    try {
      const res = await fetch('/api/feature-flags');
      if (!res.ok) return;
      const { basket } = await res.json();
      if (!basket) return;
    } catch { return; }

    basketEnabled = true;
    document.body.classList.add('mm-basket-mode');
    injectStyles();
    injectHTML();
    updateBadge();
    document.dispatchEvent(new CustomEvent('mmBasketReady'));
  }

  // ─── Styles ────────────────────────────────────────────────────────────────

  function injectStyles() {
    const el = document.createElement('style');
    el.textContent = `
      #mm-float-btn {
        position: fixed; bottom: 24px; right: 24px; z-index: 8000;
        background: ${PRIMARY}; color: #fff; border: none; border-radius: 50px;
        padding: 12px 20px; font-size: 15px; font-weight: 700; cursor: pointer;
        box-shadow: 0 4px 20px rgba(89,201,165,0.45); display: flex; align-items: center; gap: 8px;
        font-family: system-ui, sans-serif; transition: background 0.2s, transform 0.15s;
        user-select: none;
      }
      #mm-float-btn:hover { background: ${PRIMARY_DARK}; transform: translateY(-2px); }
      #mm-float-badge {
        background: #e84545; color: #fff; border-radius: 50%; width: 20px; height: 20px;
        font-size: 11px; font-weight: 800; display: none;
        align-items: center; justify-content: center;
      }
      #mm-overlay {
        position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 8900;
        display: none; backdrop-filter: blur(2px);
      }
      #mm-panel {
        position: fixed; top: 0; right: 0; height: 100%; width: 400px; max-width: 100vw;
        background: #fff; z-index: 9000; display: flex; flex-direction: column;
        box-shadow: -8px 0 40px rgba(0,0,0,0.18);
        transform: translateX(100%); transition: transform 0.3s cubic-bezier(0.4,0,0.2,1);
      }
      #mm-panel.open { transform: translateX(0); }
      #mm-panel-header {
        display: flex; align-items: center; justify-content: space-between;
        padding: 18px 20px; border-bottom: 1px solid #f0f0f0;
        background: #fafafa;
      }
      #mm-panel-header h2 {
        margin: 0; font-size: 16px; font-weight: 700; color: #1a1a1a;
        font-family: system-ui, sans-serif;
      }
      #mm-close-btn {
        background: none; border: none; cursor: pointer; font-size: 20px;
        color: #666; padding: 4px 8px; line-height: 1; border-radius: 6px;
      }
      #mm-close-btn:hover { background: #f0f0f0; }
      #mm-panel-body {
        flex: 1; overflow-y: auto; padding: 20px;
        font-family: system-ui, sans-serif;
      }
      .mm-empty {
        text-align: center; color: #9ca3af; padding: 40px 20px; font-size: 14px; line-height: 1.6;
      }
      .mm-item {
        display: flex; align-items: center; justify-content: space-between;
        padding: 12px 0; border-bottom: 1px solid #f3f4f6;
      }
      .mm-item-label { font-size: 14px; font-weight: 600; color: #1a1a1a; }
      .mm-item-price { font-size: 13px; color: #6b7280; margin-top: 2px; }
      .mm-item-del {
        background: none; border: none; color: #d1d5db; cursor: pointer;
        font-size: 16px; padding: 4px 6px; border-radius: 6px; line-height: 1;
        flex-shrink: 0; margin-left: 12px;
      }
      .mm-item-del:hover { background: #fee2e2; color: #e84545; }
      .mm-total-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 14px 0 4px; font-weight: 700; font-size: 15px; color: #1a1a1a;
      }
      .mm-voucher-row {
        display: flex; justify-content: space-between; align-items: center;
        font-size: 13px; color: #59c9a5; padding-bottom: 4px;
      }
      .mm-btn-row {
        display: flex; gap: 10px; margin-top: 16px;
      }
      .mm-btn-primary {
        flex: 1; background: ${PRIMARY}; color: #fff; border: none;
        border-radius: 10px; padding: 13px 20px; font-size: 14px; font-weight: 700;
        cursor: pointer; transition: background 0.2s; font-family: system-ui, sans-serif;
      }
      .mm-btn-primary:hover { background: ${PRIMARY_DARK}; }
      .mm-btn-primary:disabled { opacity: 0.6; cursor: default; }
      .mm-btn-secondary {
        background: none; border: 1px solid #e5e7eb; color: #6b7280; border-radius: 10px;
        padding: 13px 16px; font-size: 13px; font-weight: 600; cursor: pointer;
        font-family: system-ui, sans-serif; transition: all 0.2s;
      }
      .mm-btn-secondary:hover { border-color: #9ca3af; color: #374151; }
      .mm-back-link {
        background: none; border: none; color: ${PRIMARY}; cursor: pointer;
        font-size: 13px; font-weight: 600; padding: 0 0 16px; display: block;
        font-family: system-ui, sans-serif;
      }
      .mm-section-title {
        font-size: 12px; font-weight: 700; color: #9ca3af; text-transform: uppercase;
        letter-spacing: 0.06em; margin: 18px 0 8px;
      }
      .mm-input {
        width: 100%; box-sizing: border-box; padding: 11px 14px;
        border: 1px solid #e5e7eb; border-radius: 10px; font-size: 14px;
        font-family: system-ui, sans-serif; color: #1a1a1a; outline: none;
        margin-bottom: 8px; transition: border-color 0.15s;
      }
      .mm-input:focus { border-color: ${PRIMARY}; }
      .mm-ship-options { display: flex; flex-direction: column; gap: 6px; }
      .mm-ship-card {
        display: flex; align-items: center; gap: 10px; padding: 10px 14px;
        border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;
        font-size: 13px; color: #374151; font-family: system-ui, sans-serif;
        transition: border-color 0.15s;
      }
      .mm-ship-card:hover { border-color: #9ca3af; }
      .mm-ship-card.mm-selected { border-color: ${PRIMARY}; background: rgba(89,201,165,0.06); }
      .mm-ship-card input { margin: 0; accent-color: ${PRIMARY}; }
      .mm-social-options { display: flex; gap: 8px; }
      .mm-social-card {
        flex: 1; display: flex; align-items: center; justify-content: center; gap: 8px;
        padding: 10px; border: 2px solid #e5e7eb; border-radius: 10px; cursor: pointer;
        font-size: 13px; color: #374151; font-family: system-ui, sans-serif;
        transition: border-color 0.15s; text-align: center;
      }
      .mm-social-card:hover { border-color: #9ca3af; }
      .mm-social-card.mm-selected { border-color: ${PRIMARY}; background: rgba(89,201,165,0.06); }
      .mm-social-card input { margin: 0; accent-color: ${PRIMARY}; }
      .mm-promo-row { display: flex; gap: 8px; align-items: flex-start; }
      .mm-promo-row .mm-input { flex: 1; margin-bottom: 0; text-transform: uppercase; }
      .mm-promo-apply {
        background: none; border: 1px solid #e5e7eb; border-radius: 10px;
        padding: 11px 14px; font-size: 13px; font-weight: 600; cursor: pointer;
        white-space: nowrap; color: #374151; font-family: system-ui, sans-serif;
      }
      .mm-promo-apply:hover { border-color: #9ca3af; }
      .mm-promo-msg { font-size: 12px; margin: 4px 0 8px; }
      .mm-error { color: #e84545; font-size: 13px; margin-top: 8px; }
      .mm-pay-btn { width: 100%; margin-top: 16px; font-size: 15px; padding: 15px; }
      .mm-note { font-size: 11px; color: #9ca3af; text-align: center; margin-top: 10px; }

      /* Show basket-only elements when basket mode is active */
      .basket-show { display: none !important; }
      body.mm-basket-mode .basket-show { display: revert !important; }

      @media (max-width: 480px) {
        #mm-float-btn { bottom: 16px; right: 16px; }
        #mm-panel { width: 100vw; }
      }
    `;
    document.head.appendChild(el);
  }

  // ─── HTML ──────────────────────────────────────────────────────────────────

  function injectHTML() {
    // Overlay
    const overlay = document.createElement('div');
    overlay.id = 'mm-overlay';
    overlay.onclick = closePanel;
    document.body.appendChild(overlay);

    // Panel
    const panel = document.createElement('div');
    panel.id = 'mm-panel';
    panel.innerHTML = `
      <div id="mm-panel-header">
        <h2>🛒 Your Basket</h2>
        <button id="mm-close-btn" aria-label="Close basket">✕</button>
      </div>
      <div id="mm-panel-body"></div>
    `;
    document.body.appendChild(panel);
    document.getElementById('mm-close-btn').onclick = closePanel;

    // Floating button
    const btn = document.createElement('button');
    btn.id = 'mm-float-btn';
    btn.setAttribute('aria-label', 'Open basket');
    btn.innerHTML = `🛒 Basket <span id="mm-float-badge"></span>`;
    btn.onclick = togglePanel;
    document.body.appendChild(btn);
  }

  // ─── Panel rendering ───────────────────────────────────────────────────────

  function openPanel() {
    panelOpen = true;
    document.getElementById('mm-panel')?.classList.add('open');
    const overlay = document.getElementById('mm-overlay');
    if (overlay) overlay.style.display = 'block';
    renderContent();
  }

  function closePanel() {
    panelOpen = false;
    document.getElementById('mm-panel')?.classList.remove('open');
    const overlay = document.getElementById('mm-overlay');
    if (overlay) overlay.style.display = 'none';
  }

  function togglePanel() { panelOpen ? closePanel() : openPanel(); }

  function updateBadge() {
    const badge = document.getElementById('mm-float-badge');
    if (!badge) return;
    const count = state.items.length;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  }

  function renderContent() {
    const body = document.getElementById('mm-panel-body');
    if (!body) return;
    body.innerHTML = inCheckout ? buildCheckoutHTML() : buildItemsHTML();
    inCheckout ? bindCheckoutEvents() : bindItemsEvents();
  }

  // ─── Items view ────────────────────────────────────────────────────────────

  function buildItemsHTML() {
    if (state.items.length === 0) {
      return `<div class="mm-empty">Your basket is empty.<br><br>Add items from any product page.</div>`;
    }

    let html = '';
    for (const item of state.items) {
      html += `
        <div class="mm-item">
          <div>
            <div class="mm-item-label">${item.label}</div>
            <div class="mm-item-price">£${Number(item.price).toFixed(2)}</div>
          </div>
          <button class="mm-item-del" data-id="${item.orderId}" title="Remove">✕</button>
        </div>`;
    }

    const subtotal = state.items.reduce((s, i) => s + Number(i.price), 0);
    if (voucherApplied > 0) {
      html += `<div class="mm-voucher-row"><span>Voucher discount</span><span>−£${voucherApplied.toFixed(2)}</span></div>`;
    }
    html += `<div class="mm-total-row"><span>Subtotal</span><span>£${Math.max(0, subtotal - voucherApplied).toFixed(2)}</span></div>`;
    html += `<p style="font-size:12px;color:#9ca3af;margin:2px 0 0;">Shipping added at checkout</p>`;

    html += `<div class="mm-btn-row">
      <button class="mm-btn-secondary" id="mm-keep-btn">← Keep shopping</button>
      <button class="mm-btn-primary" id="mm-checkout-btn">Checkout →</button>
    </div>`;

    return html;
  }

  function bindItemsEvents() {
    document.querySelectorAll('.mm-item-del').forEach(btn => {
      btn.onclick = () => remove(btn.dataset.id);
    });
    const keepBtn = document.getElementById('mm-keep-btn');
    if (keepBtn) keepBtn.onclick = () => { window.location.href = '/'; };
    const checkoutBtn = document.getElementById('mm-checkout-btn');
    if (checkoutBtn) checkoutBtn.onclick = () => { inCheckout = true; renderContent(); };
  }

  // ─── Checkout form view ────────────────────────────────────────────────────

  function getSubtotal() {
    return state.items.reduce((s, i) => s + Number(i.price), 0);
  }

  function getShipCost() {
    const val = document.querySelector('input[name="mm_ship"]:checked')?.value;
    if (val === 'GB') return 5;
    if (val === 'GI_DELIVER') return 3;
    return 0;
  }

  function getTotalText() {
    const t = Math.max(0, getSubtotal() - voucherApplied) + getShipCost();
    return `£${t.toFixed(2)}`;
  }

  function buildCheckoutHTML() {
    const subtotal = Math.max(0, getSubtotal() - voucherApplied);
    return `
      <button class="mm-back-link" id="mm-back-btn">← Back to basket</button>

      <div class="mm-section-title">Your details</div>
      <input type="email" id="mm-email" placeholder="Email address" class="mm-input" autocomplete="email" />
      <input type="tel" id="mm-phone" placeholder="Phone number" class="mm-input" autocomplete="tel" />

      <div class="mm-section-title">Shipping</div>
      <div class="mm-ship-options">
        <label class="mm-ship-card">
          <input type="radio" name="mm_ship" value="GI_COLLECT" />
          <span><strong>📍 Collection</strong> — Free<br><span style="font-size:11px;color:#9ca3af;">Atlantic Suites</span></span>
        </label>
        <label class="mm-ship-card">
          <input type="radio" name="mm_ship" value="GI_DELIVER" />
          <span><strong>🚚 Gibraltar Delivery</strong> — +£3.00<br><span style="font-size:11px;color:#9ca3af;">Within 48 hours</span></span>
        </label>
        <label class="mm-ship-card">
          <input type="radio" name="mm_ship" value="GB" />
          <span><strong>🇬🇧 UK Delivery</strong> — +£5.00<br><span style="font-size:11px;color:#9ca3af;">Royal Mail Tracked</span></span>
        </label>
      </div>

      <div class="mm-section-title">Social media</div>
      <div class="mm-social-options">
        <label class="mm-social-card">
          <input type="radio" name="mm_social" value="yes" /> Yes, share it! 📸
        </label>
        <label class="mm-social-card">
          <input type="radio" name="mm_social" value="no" /> No, keep private 🔒
        </label>
      </div>

      <div class="mm-section-title">Promo code</div>
      <div class="mm-promo-row">
        <input type="text" id="mm-promo" placeholder="Enter code" class="mm-input" />
        <button class="mm-promo-apply" id="mm-promo-btn">Apply</button>
      </div>
      <p id="mm-promo-msg" class="mm-promo-msg" style="display:none;"></p>

      <button class="mm-btn-primary mm-pay-btn" id="mm-pay-btn">Pay ${getTotalText()} securely</button>
      <p id="mm-pay-error" class="mm-error" style="display:none;"></p>
      <p class="mm-note">Secured by Stripe · All prices in GBP</p>
    `;
  }

  function bindCheckoutEvents() {
    document.getElementById('mm-back-btn')?.addEventListener('click', () => {
      inCheckout = false; renderContent();
    });

    document.querySelectorAll('input[name="mm_ship"]').forEach(r => {
      r.addEventListener('change', () => {
        document.querySelectorAll('.mm-ship-card').forEach(c => c.classList.remove('mm-selected'));
        r.closest('.mm-ship-card').classList.add('mm-selected');
        updatePayTotal();
      });
    });

    document.querySelectorAll('input[name="mm_social"]').forEach(r => {
      r.addEventListener('change', () => {
        document.querySelectorAll('.mm-social-card').forEach(c => c.classList.remove('mm-selected'));
        r.closest('.mm-social-card').classList.add('mm-selected');
      });
    });

    document.getElementById('mm-promo-btn')?.addEventListener('click', applyPromo);
    document.getElementById('mm-pay-btn')?.addEventListener('click', submitCheckout);
  }

  function updatePayTotal() {
    const btn = document.getElementById('mm-pay-btn');
    if (btn) btn.textContent = `Pay ${getTotalText()} securely`;
  }

  async function applyPromo() {
    const code = document.getElementById('mm-promo')?.value.trim();
    const msgEl = document.getElementById('mm-promo-msg');
    if (!code || !msgEl) return;

    document.getElementById('mm-promo-btn').textContent = '...';
    try {
      const res = await fetch('/api/voucher-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code })
      });
      const data = await res.json();
      if (data.valid) {
        voucherApplied = data.value;
        voucherCode = data.code;
        msgEl.style.color = '#59c9a5';
        msgEl.textContent = `Voucher applied! −£${data.value}`;
        msgEl.style.display = 'block';
        document.getElementById('mm-promo').disabled = true;
        document.getElementById('mm-promo-btn').style.display = 'none';
        updatePayTotal();
      } else {
        msgEl.style.color = '#e84545';
        msgEl.textContent = data.error || 'Invalid code';
        msgEl.style.display = 'block';
      }
    } catch {
      if (msgEl) { msgEl.style.color = '#e84545'; msgEl.textContent = 'Error checking code'; msgEl.style.display = 'block'; }
    } finally {
      const btn = document.getElementById('mm-promo-btn');
      if (btn) btn.textContent = 'Apply';
    }
  }

  async function submitCheckout() {
    const email = document.getElementById('mm-email')?.value.trim();
    const phone = document.getElementById('mm-phone')?.value.trim();
    const shipping = document.querySelector('input[name="mm_ship"]:checked')?.value;
    const socialVal = document.querySelector('input[name="mm_social"]:checked')?.value;
    const errEl = document.getElementById('mm-pay-error');

    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; } };

    if (!email || !/\S+@\S+\.\S+/.test(email)) { showErr('Please enter a valid email address.'); return; }
    if (!phone || phone.length < 6) { showErr('Please enter your phone number.'); return; }
    if (!shipping) { showErr('Please select a shipping method.'); return; }
    if (!socialVal) { showErr('Please answer the social media question.'); return; }
    if (errEl) errEl.style.display = 'none';

    const payBtn = document.getElementById('mm-pay-btn');
    payBtn.disabled = true;
    payBtn.textContent = 'Processing...';

    try {
      const res = await fetch('/api/basket-checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderIds: state.items.map(i => i.orderId),
          email,
          phone,
          shippingMethod: shipping,
          socialPermission: socialVal === 'yes',
          voucherCode: voucherCode || undefined
        })
      });

      const data = await res.json();
      if (!res.ok || data.error) {
        showErr(data.error || 'Checkout failed. Please try again.');
        payBtn.disabled = false;
        payBtn.textContent = `Pay ${getTotalText()} securely`;
        return;
      }

      clear();
      window.location.href = data.checkoutUrl;
    } catch {
      showErr('Something went wrong. Please try again.');
      payBtn.disabled = false;
      payBtn.textContent = `Pay ${getTotalText()} securely`;
    }
  }

  // ─── Expose ────────────────────────────────────────────────────────────────

  window.mmBasket = {
    add,
    remove,
    clear,
    isEnabled: () => basketEnabled,
    getCount: () => state.items.length,
    getItems: () => [...state.items],
  };

  init();
})();
