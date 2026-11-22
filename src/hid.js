/* WebHID transport for the Axon programmer. */
(function (root) {
  'use strict';
  const { VENDOR_ID, PRODUCT_ID, REPORT_ID } = root.Axon;

  function reportBytes(rep) {
    return Math.ceil(rep.items.reduce((n, it) => n + it.reportSize * it.reportCount, 0) / 8);
  }

  class WebHidTransport {
    constructor(device, { timeout = 1500 } = {}) {
      this.device = device;
      this.timeout = timeout;
      this.waiter = null;
      this.onReport = (e) => {
        const data = new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
        const full = new Uint8Array(64);
        full[0] = e.reportId;
        full.set(data.subarray(0, 63), 1);
        if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(full); }
      };
    }

    async open() {
      if (!this.device.opened) await this.device.open();
      this.device.addEventListener('inputreport', this.onReport);
      // Work out how the descriptor wants output reports sent.
      this.outId = REPORT_ID;
      this.outLen = 63;
      this.numbered = true;
      const outs = this.device.collections.flatMap((c) => c.outputReports || []);
      const mine = outs.find((r) => r.reportId === REPORT_ID);
      if (mine) this.outLen = reportBytes(mine) || 63;
      else if (outs.length && outs[0].reportId === 0) { this.numbered = false; this.outId = 0; this.outLen = reportBytes(outs[0]) || 64; }
    }

    async close() {
      this.device.removeEventListener('inputreport', this.onReport);
      if (this.waiter) { this.waiter.reject(new Error('Device closed.')); this.waiter = null; }
      try { if (this.device.opened) await this.device.close(); } catch { /* already gone */ }
    }

    exchange(out) {
      return new Promise((resolve, reject) => {
        const payload = new Uint8Array(this.outLen);
        // Numbered: report id goes in the id field. Unnumbered: whole 64-byte frame is data.
        payload.set(this.numbered ? out.subarray(1, 1 + this.outLen) : out.subarray(0, this.outLen));
        const timer = setTimeout(() => {
          if (this.waiter) { this.waiter = null; reject(new Error('The programmer did not answer (timeout).')); }
        }, this.timeout);
        this.waiter = {
          resolve: (r) => { clearTimeout(timer); resolve(r); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        };
        this.device.sendReport(this.outId, payload).catch((e) => {
          clearTimeout(timer); this.waiter = null; reject(e);
        });
      });
    }
  }

  const isAxon = (d) => d.vendorId === VENDOR_ID && d.productId === PRODUCT_ID;

  async function findDevice() {
    if (!navigator.hid) return null;
    let devs = (await navigator.hid.getDevices()).filter(isAxon);
    if (!devs.length) {
      try { devs = await navigator.hid.requestDevice({ filters: [{ vendorId: VENDOR_ID, productId: PRODUCT_ID }] }); }
      catch { devs = []; }
    }
    return devs.find(isAxon) || null;
  }

  root.AxonHid = { WebHidTransport, findDevice, isAxon };
})(self);
