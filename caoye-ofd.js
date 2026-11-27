/* 草叶 OFD 预览 (caoye-ofd). Copyright (c) 2026 AndyChao. SPDX-License-Identifier: MIT */
/**
 * 草叶 OFD 预览组件。解析和绘制在 viewer.js。
 *
 * 页面里放一个占满区域的元素，再把档案文件地址或文件内容交给它：
 *
 *   <caoye-ofd id="preview" style="height:100%"></caoye-ofd>
 *   <script type="module">
 *     import "./caoye-ofd.js";
 *     const preview = document.querySelector("#preview");
 *     preview.open("/archive/file/123.ofd");
 *     preview.addEventListener("ofd-load", (event) => console.log(event.detail.pages));
 *     preview.addEventListener("ofd-error", (event) => console.log(event.detail.message));
 *   </script>
 *
 * open 接受 URL、ArrayBuffer、Blob 或 File。也可以写 src 属性，地址变化时会重新打开。
 * print() 调起浏览器的打印对话框。工作人员直接按 Ctrl+P 时，同样只打印已打开的版式页。
 * setArchiveStamp({ rows, page, marginTop, marginRight, fontSize, color })
 * 在预览上补一枚档号章，不改原文件。文件里已有章时不再叠加。
 * download(filename) 把参数章写成注释层图片并下载。文件里已有章时下载原文件。
 */

import { buildOfd, openOfd, paintDocument, renderDocument } from "./viewer.js";

const TEMPLATE = `
  <style>
    :host {
      display: flex;
      flex-direction: column;
      min-height: 0;
      height: 100%;
      color: #1c1c1c;
      background: #d9d9d6;
      font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    .toolbar {
      flex: none;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      background: #f7f7f5;
      border-bottom: 1px solid #c8c8c4;
    }
    button {
      border: 1px solid #b9b9b4;
      background: #fff;
      border-radius: 6px;
      padding: 6px 10px;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    button:hover { background: #f0f0ec; }
    .status {
      margin-left: 8px;
      font-size: 13px;
      color: #333;
    }
    .status.warn { color: #8a3b00; }
    .pages {
      flex: 1;
      min-height: 0;
      overflow: auto;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 18px;
      padding: 12px 16px 32px;
    }
    .page { width: max-content; }
    .page-label { font-size: 12px; color: #555; margin: 0 0 6px 2px; }
    canvas {
      display: block;
      background: #fff;
      box-shadow: 0 1px 4px rgba(0, 0, 0, 0.18);
    }
    .empty {
      padding: 48px 16px;
      text-align: center;
      color: #555;
    }
    @media print {
      :host {
        display: block;
        height: auto;
        overflow: visible;
        background: #fff;
      }
      .toolbar, .page-label, .empty { display: none !important; }
      .pages {
        display: block;
        width: 100%;
        overflow: visible;
        height: auto;
        padding: 0;
        gap: 0;
      }
      .page {
        width: var(--page-w, 210mm);
        height: var(--page-h, 297mm);
        /* 窄页保持自己的版心宽度，靠左右自动外边距在纸张里居中。 */
        margin: 0 auto;
        padding: 0;
        overflow: hidden;
        break-inside: avoid;
        break-after: page;
        page-break-after: always;
      }
      .page:last-child {
        break-after: auto;
        page-break-after: auto;
      }
      canvas {
        display: block;
        width: var(--page-w, 210mm) !important;
        height: var(--page-h, 297mm) !important;
        box-shadow: none;
      }
    }
  </style>
  <div class="toolbar" part="toolbar">
    <button type="button" data-action="zoom-out">缩小</button>
    <button type="button" data-action="zoom-in">放大</button>
    <button type="button" data-action="fit">适合宽度</button>
    <button type="button" data-action="print">打印</button>
    <div class="status" part="status">未打开文件</div>
  </div>
  <div class="pages" part="pages">
    <div class="empty">打开档案中的 OFD 文件后在这里预览。</div>
  </div>
`;

export class CaoyeOfd extends HTMLElement {
  static get observedAttributes() {
    return ["src"];
  }

  constructor() {
    super();
    this._model = null;
    this._scale = 3.2;
    this._token = 0;
    this._openedSrc = "";
    this._archiveStamp = null;
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML = TEMPLATE;
    this._status = root.querySelector(".status");
    this._pages = root.querySelector(".pages");
    this._empty = root.querySelector(".empty");
    root.querySelector('[data-action="zoom-in"]').addEventListener("click", () => this.zoomIn());
    root.querySelector('[data-action="zoom-out"]').addEventListener("click", () => this.zoomOut());
    root.querySelector('[data-action="fit"]').addEventListener("click", () => this.fitWidth());
    root.querySelector('[data-action="print"]').addEventListener("click", () => this.print());
  }

  connectedCallback() {
    this._syncSrc();
  }

  attributeChangedCallback() {
    if (this.isConnected) {
      this._syncSrc();
    }
  }

  get pageCount() {
    return this._model ? this._model.pages.length : 0;
  }

  async open(source, name) {
    const token = ++this._token;
    if (this._abort) {
      this._abort.abort();
    }
    const controller = typeof source === "string" ? new AbortController() : null;
    this._abort = controller;
    if (typeof source === "string") {
      this._openedSrc = source;
    }
    this._openedName = name || "";
    this._setStatus(name ? "正在打开 " + name + " …" : "正在打开…");
    try {
      const buffer = await toArrayBuffer(source, controller && controller.signal);
      if (token !== this._token) {
        return;
      }
      this._model = await openOfd(buffer);
      this._model.archiveStamp = this._archiveStamp;
      if (token !== this._token) {
        return;
      }
      this._fitScale();
      const warnings = await this._paint();
      if (token !== this._token) {
        return;
      }
      this.dispatchEvent(new CustomEvent("ofd-load", {
        bubbles: true,
        composed: true,
        detail: { pages: this._model.pages.length, warnings: warnings },
      }));
    } catch (error) {
      if (token !== this._token || (error && error.name === "AbortError")) {
        return;
      }
      this._fail(error);
    }
  }

  close() {
    this._token += 1;
    this._model = null;
    this._openedSrc = "";
    this._pages.replaceChildren(this._empty);
    this._empty.hidden = false;
    this._setStatus("未打开文件");
  }

  zoomIn() {
    this._rescale(this._scale * 1.15);
  }

  zoomOut() {
    this._rescale(this._scale / 1.15);
  }

  fitWidth() {
    if (!this._model) {
      return Promise.resolve();
    }
    this._fitScale();
    return this._paint();
  }

  setArchiveStamp(options) {
    this._archiveStamp = normalizeArchiveStamp(options);
    if (!this._model) {
      return Promise.resolve([]);
    }
    this._model.archiveStamp = this._archiveStamp;
    return this._paint();
  }

  clearArchiveStamp() {
    return this.setArchiveStamp(null);
  }

  async download(filename) {
    if (!this._model) {
      this._setStatus("请先打开文件");
      return;
    }
    const bytes = await buildOfd(this._model);
    const link = document.createElement("a");
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/ofd" }));
    link.href = url;
    link.download = filename || stampedName(this._openedName);
    link.click();
    URL.revokeObjectURL(url);
  }

  print() {
    if (!this._model) {
      return;
    }
    preparePrintLayout();
    window.print();
  }

  _usePrintResolution() {
    if (!this._model || !this._model.prepared || this._screenScale != null) {
      return;
    }
    this._screenScale = this._scale;
    const dpr = window.devicePixelRatio || 1;
    paintDocument(this._model, this._pages, Math.min(6, 8 / dpr));
  }

  _restoreScreenResolution() {
    if (this._screenScale == null || !this._model || !this._model.prepared) {
      return;
    }
    const scale = this._screenScale;
    this._screenScale = null;
    this._scale = scale;
    paintDocument(this._model, this._pages, scale);
  }

  _syncSrc() {
    const src = this.getAttribute("src");
    if (src && src !== this._openedSrc) {
      this.open(src);
    }
  }

  _fitScale() {
    const pageW = (this._model && this._model.box[2]) || 210;
    const width = this._pages.clientWidth || this.clientWidth;
    this._scale = width > 80 ? Math.max(1.2, (width - 48) / pageW) : 3.2;
  }

  _rescale(next) {
    this._scale = Math.min(8, Math.max(1, next));
    return this._paint();
  }

  _paint() {
    if (!this._model) {
      return Promise.resolve([]);
    }
    this._empty.hidden = true;
    return renderDocument(this._model, this._pages, this._scale).then((warnings) => {
      const text = this._model.pages.length + " 页";
      this._setStatus(warnings.length ? text + "。" + warnings.join("；") : text, warnings.length > 0);
      return warnings;
    });
  }

  _fail(error) {
    this._model = null;
    this._pages.replaceChildren(this._empty);
    this._empty.hidden = false;
    const message = error && error.message ? error.message : String(error);
    this._setStatus(message, true);
    this.dispatchEvent(new CustomEvent("ofd-error", {
      bubbles: true,
      composed: true,
      detail: { message: message },
    }));
  }

  _setStatus(message, warn) {
    this._status.textContent = message;
    this._status.className = warn ? "status warn" : "status";
  }
}

async function toArrayBuffer(source, signal) {
  if (source instanceof ArrayBuffer) {
    return source;
  }
  if (ArrayBuffer.isView(source)) {
    return source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
  }
  if (typeof Blob !== "undefined" && source instanceof Blob) {
    return source.arrayBuffer();
  }
  if (typeof source === "string") {
    const url = /[^\u0000-\u007F]/.test(source) ? encodeURI(source) : source;
    const response = await fetch(url, { signal: signal });
    if (!response.ok) {
      throw new Error("文件读取失败：" + response.status);
    }
    return response.arrayBuffer();
  }
  throw new Error("无法打开该文件");
}

function stampedName(name) {
  const base = name && String(name).trim() ? String(name).replace(/\.ofd$/i, "") : "preview";
  return base + "-档号章.ofd";
}

function normalizeArchiveStamp(options) {
  if (!options) {
    return null;
  }
  const rows = Array.isArray(options) ? options : options.rows;
  if (!Array.isArray(rows)) {
    return null;
  }
  const cleaned = rows.filter((row) => Array.isArray(row)).map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
  if (!cleaned.length) {
    return null;
  }
  const source = Array.isArray(options) ? {} : options;
  const page = Number(source.page);
  return {
    rows: cleaned,
    page: Number.isInteger(page) && page >= 0 ? page : 0,
    marginTop: finiteNumber(source.marginTop, 10),
    marginRight: finiteNumber(source.marginRight, 10),
    fontSize: finiteNumber(source.fontSize, 3.2),
    color: typeof source.color === "string" && source.color ? source.color : "#e10600",
  };
}

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function preparePrintLayout() {
  ensurePrintStyle();
  const previews = [...document.querySelectorAll("caoye-ofd")].filter((element) => element.pageCount > 0);
  document.documentElement.classList.toggle("caoye-ofd-printing", previews.length > 0);
  if (previews.length && !document.getElementById("caoye-ofd-page-size")) {
    const pageStyle = document.createElement("style");
    pageStyle.id = "caoye-ofd-page-size";
    pageStyle.textContent = "@page { margin: 0; }";
    document.head.appendChild(pageStyle);
  }
  previews.forEach((element) => {
    try {
      element._usePrintResolution();
    } catch (error) {
      // 打印分辨率切换失败时保留当前画面，避免打印对话框空白。
    }
  });
}

function ensurePrintStyle() {
  if (document.getElementById("caoye-ofd-print-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "caoye-ofd-print-style";
  style.textContent = `
    @media print {
      html.caoye-ofd-printing,
      html.caoye-ofd-printing body {
        margin: 0 !important;
        padding: 0 !important;
      }
      html.caoye-ofd-printing body * { visibility: hidden !important; }
      html.caoye-ofd-printing caoye-ofd {
        visibility: visible !important;
        position: absolute !important;
        left: 0 !important;
        right: 0 !important;
        top: 0 !important;
        width: auto !important;
        height: auto !important;
        overflow: visible !important;
        background: #fff !important;
      }
    }
  `;
  document.head.appendChild(style);
}

ensurePrintStyle();
window.addEventListener("beforeprint", preparePrintLayout);
window.addEventListener("afterprint", () => {
  document.documentElement.classList.remove("caoye-ofd-printing");
  const pageStyle = document.getElementById("caoye-ofd-page-size");
  if (pageStyle) {
    pageStyle.remove();
  }
  document.querySelectorAll("caoye-ofd").forEach((element) => element._restoreScreenResolution());
});

if (!customElements.get("caoye-ofd")) {
  customElements.define("caoye-ofd", CaoyeOfd);
}
