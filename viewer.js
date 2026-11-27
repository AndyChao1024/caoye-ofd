/* 草叶 OFD 预览 (caoye-ofd). Copyright (c) 2026 AndyChao. SPDX-License-Identifier: MIT */
/**
 * 按 OFD 国标（GB/T 33190）做的第一版预览。
 * 绘制文字、图片、直线/折线路径、注释层里的档号章，以及电子签章外观。
 * buildOfd 把参数章写成注释层 PNG。不绘制模板页和复杂曲线。
 */

const OFD_NS = "http://www.ofdspec.org/2016";

export async function openOfd(buffer) {
  const files = await unzip(buffer);
  const ofdPath = findEntry(files, "OFD.xml");
  if (!ofdPath) {
    throw new Error("包内没有 OFD.xml，这不是 OFD 文件");
  }
  const ofdXml = parseXml(files.get(ofdPath));
  const docRoot = childText(ofdXml, "DocRoot");
  if (!docRoot) {
    throw new Error("OFD.xml 里没有 DocRoot");
  }
  const docPath = resolvePath(parentPath(ofdPath), docRoot);
  const docXml = parseXml(files.get(docPath));
  const docDir = parentPath(docPath);
  const box = readPhysicalBox(docXml) || [0, 0, 210, 297];
  const resources = loadResources(files, docXml, docDir);
  const pages = [...elements(docXml, "Page")].map((page) => ({
    id: page.getAttribute("ID"),
    href: attr(page, "BaseLoc"),
  }));
  const seals = loadSeals(files, ofdXml, ofdPath);
  const annotations = loadAnnotations(files, docXml, docDir);
  return { files, docDir, docPath, box, resources, pages, seals, annotations };
}

export async function renderDocument(model, container, scale) {
  if (!model.prepared) {
    model.prepared = {
      families: await loadFonts(model.resources.fonts),
      images: await loadImages(model.resources.images),
      sealBitmaps: await loadSealBitmaps(model.seals || []),
    };
  }
  const warnings = [];
  paintDocument(model, container, scale, warnings);
  return warnings;
}

export function paintDocument(model, container, scale, warnings) {
  const notes = warnings || [];
  const prepared = model.prepared;
  if (!prepared) {
    return notes;
  }
  container.replaceChildren();
  model.pages.forEach((page, index) => {
    const href = resolvePath(model.docDir, page.href);
    const bytes = model.files.get(href);
    const section = document.createElement("section");
    section.className = "page";
    const canvas = document.createElement("canvas");
    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = "第 " + (index + 1) + " 页";
    section.append(label, canvas);
    container.append(section);
    if (!bytes) {
      notes.push("缺少页面：" + href);
      return;
    }
    const pageXml = parseXml(bytes);
    const box = readPhysicalBox(pageXml) || model.box;
    if (!box || box.length < 4) {
      notes.push("第 " + (index + 1) + " 页尺寸无效");
      return;
    }
    section.style.setProperty("--page-w", box[2] + "mm");
    section.style.setProperty("--page-h", box[3] + "mm");
    const pageSeals = prepared.sealBitmaps.filter((seal) => seal.pageId === page.id);
    try {
      drawPage(canvas, pageXml, box, scale, prepared.families, prepared.images, pageSeals, notes, model.annotations || [], model.files, page.id, index, model.archiveStamp);
    } catch (error) {
      notes.push("第 " + (index + 1) + " 页绘制失败");
    }
  });
  return notes;
}

async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  const lower = Math.max(0, bytes.length - 22 - 0xffff);
  for (let i = bytes.length - 22; i >= lower; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("无法解压，文件不是 zip 格式的 OFD");
  }
  const count = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(cursor, true) !== 0x02014b50) {
      throw new Error("ZIP 目录损坏");
    }
    const method = view.getUint16(cursor + 10, true);
    const compSize = view.getUint32(cursor + 20, true);
    const nameLen = view.getUint16(cursor + 28, true);
    const extraLen = view.getUint16(cursor + 30, true);
    const commentLen = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = decodeText(bytes.subarray(cursor + 46, cursor + 46 + nameLen)).replace(/\\/g, "/");
    cursor += 46 + nameLen + extraLen + commentLen;
    if (!name || name.endsWith("/")) {
      continue;
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart < 0 || compSize < 0 || dataStart + compSize > bytes.length) {
      throw new Error("ZIP 内容损坏");
    }
    const compressed = bytes.subarray(dataStart, dataStart + compSize);
    files.set(name, await inflate(method, compressed));
  }
  return files;
}

async function inflate(method, compressed) {
  if (method === 0) {
    return compressed.slice();
  }
  if (method !== 8) {
    throw new Error("不支持的压缩方式：" + method);
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const out = await new Response(stream).arrayBuffer();
  return new Uint8Array(out);
}

function parseXml(bytes) {
  if (!bytes) {
    throw new Error("OFD 内部文件缺失");
  }
  const text = decodeText(bytes).replace(/^\uFEFF/, "");
  const doc = new DOMParser().parseFromString(text, "text/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("XML 无法解析");
  }
  return doc;
}

function decodeText(bytes) {
  return new TextDecoder("utf-8").decode(bytes);
}

function findEntry(files, suffix) {
  if (files.has(suffix)) {
    return suffix;
  }
  for (const name of files.keys()) {
    if (name === suffix || name.endsWith("/" + suffix)) {
      return name;
    }
  }
  return "";
}

function parentPath(path) {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function resolvePath(dir, relative) {
  const parts = dir ? dir.split("/").filter(Boolean) : [];
  for (const part of String(relative || "").replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}

function elements(node, localName) {
  if (!node) {
    return [];
  }
  const found = node.getElementsByTagNameNS
    ? node.getElementsByTagNameNS(OFD_NS, localName)
    : [];
  if (found.length) {
    return [...found];
  }
  return [...node.getElementsByTagName("*")].filter((el) => el.localName === localName);
}

function childText(node, localName) {
  const el = elements(node, localName)[0];
  return el ? el.textContent.trim() : "";
}

function attr(node, name) {
  return node.getAttribute(name) || node.getAttributeNS(null, name) || "";
}

function readPhysicalBox(xml) {
  const area = elements(xml, "PhysicalBox")[0];
  if (!area) {
    return null;
  }
  const nums = area.textContent.trim().split(/\s+/).map(Number);
  if (nums.length < 4 || nums.some((n) => Number.isNaN(n))) {
    return null;
  }
  return nums;
}

function loadResources(files, docXml, docDir) {
  const fonts = new Map();
  const images = new Map();
  for (const resEl of [...elements(docXml, "PublicRes"), ...elements(docXml, "DocumentRes")]) {
    const href = resEl.textContent.trim();
    const resPath = resolvePath(docDir, href);
    const resXml = parseXml(files.get(resPath));
    const base = attr(resXml.documentElement, "BaseLoc") || ".";
    const baseDir = resolvePath(parentPath(resPath), base);
    for (const font of elements(resXml, "Font")) {
      const fileName = childText(font, "FontFile");
      fonts.set(attr(font, "ID"), {
        name: attr(font, "FontName") || "ofd-font",
        bytes: fileName ? files.get(resolvePath(baseDir, fileName)) : null,
      });
    }
    for (const media of elements(resXml, "MultiMedia")) {
      const fileName = childText(media, "MediaFile");
      images.set(attr(media, "ID"), {
        bytes: fileName ? files.get(resolvePath(baseDir, fileName)) : null,
        type: mediaType(attr(media, "Type"), fileName),
      });
    }
  }
  return { fonts, images };
}

function mediaType(type, fileName) {
  const ext = (fileName || "").split(".").pop().toLowerCase();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "gif") return "image/gif";
  if (ext === "bmp") return "image/bmp";
  if (String(type).toLowerCase() === "image") return "image/png";
  return "application/octet-stream";
}

async function loadFonts(fonts) {
  const families = new Map();
  for (const [id, font] of fonts) {
    const family = "ofd-font-" + id;
    families.set(id, family);
    if (!font.bytes) {
      families.set(id, systemFontStack(font.name));
      continue;
    }
    try {
      // 版式软件抽出的子集字体常有三处不合 TrueType 校验，浏览器会整表拒绝，
      // 画面就退回更细的衬线体：OS/2 表被写成小写 os/2、表目录未按标签排序、
      // cmap 最后一段 U+FFFF 的 idDelta 为 0（会映射到不存在的字形）。
      const fixed = sanitizeEmbeddedFont(font.bytes);
      const face = new FontFace(family, fixed.slice().buffer);
      await face.load();
      document.fonts.add(face);
    } catch (error) {
      families.set(id, systemFontStack(font.name));
    }
  }
  await document.fonts.ready;
  return families;
}

function systemFontStack(fontName) {
  const name = String(fontName || "").replace(/\s+/g, "");
  if (/黑体|等线|雅黑|SimHei|YaHei|DengXian/.test(name)) {
    return '"SimHei","Microsoft YaHei","DengXian",sans-serif';
  }
  if (/楷|KaiTi/.test(name)) {
    return '"KaiTi","STKaiti",serif';
  }
  if (/仿宋|FangSong/.test(name)) {
    return '"FangSong","STFangsong",serif';
  }
  if (/小标宋|标宋|中宋/.test(name)) {
    return '"SimSun","STZhongsong","NSimSun",serif';
  }
  if (/宋|SimSun|Song/.test(name)) {
    return '"SimSun","NSimSun",serif';
  }
  return '"SimSun","Microsoft YaHei",serif';
}

function sanitizeEmbeddedFont(bytes) {
  if (!bytes || bytes.length < 12) {
    return bytes;
  }
  const data = bytes.slice();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const scalar = view.getUint32(0);
  if (scalar !== 0x00010000 && scalar !== 0x74727565) {
    return bytes;
  }
  const num = view.getUint16(4);
  if (12 + num * 16 > data.length) {
    return bytes;
  }
  const records = [];
  let changed = false;
  for (let i = 0; i < num; i++) {
    const at = 12 + i * 16;
    let tag = String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
    if (tag.toLowerCase() === "os/2") {
      tag = "OS/2";
      changed = true;
    }
    records.push({
      tag: tag,
      offset: view.getUint32(at + 8),
      length: view.getUint32(at + 12)
    });
  }
  const sorted = records.slice().sort(function (a, b) {
    return a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0;
  });
  for (let i = 0; i < num; i++) {
    if (records[i].tag !== sorted[i].tag || records[i].offset !== sorted[i].offset) {
      changed = true;
    }
  }
  const cmap = sorted.find(function (record) { return record.tag === "cmap"; });
  if (cmap && fixCmapTerminator(view, cmap.offset, cmap.length)) {
    changed = true;
  }
  if (!changed) {
    return bytes;
  }
  const head = sorted.find(function (record) { return record.tag === "head"; });
  if (head && head.offset + 12 <= data.length) {
    view.setUint32(head.offset + 8, 0);
  }
  for (let i = 0; i < num; i++) {
    const record = sorted[i];
    const at = 12 + i * 16;
    writeTag(data, at, record.tag);
    view.setUint32(at + 4, tableChecksum(data, record.offset, record.length));
    view.setUint32(at + 8, record.offset);
    view.setUint32(at + 12, record.length);
  }
  if (head && head.offset + 12 <= data.length) {
    const adjustment = (0xB1B0AFBA - tableChecksum(data, 0, data.length)) >>> 0;
    view.setUint32(head.offset + 8, adjustment);
    const headIndex = sorted.findIndex(function (record) { return record.tag === "head"; });
    view.setUint32(12 + headIndex * 16 + 4, tableChecksum(data, head.offset, head.length));
  }
  return data;
}

function fixCmapTerminator(view, offset, length) {
  if (offset + 4 > view.byteLength || length < 4) {
    return false;
  }
  const numEnc = view.getUint16(offset + 2);
  let changed = false;
  for (let i = 0; i < numEnc; i++) {
    const rec = offset + 4 + i * 8;
    if (rec + 8 > offset + length) {
      break;
    }
    const sub = offset + view.getUint32(rec + 4);
    if (sub + 14 > view.byteLength || view.getUint16(sub) !== 4) {
      continue;
    }
    const segCount = view.getUint16(sub + 6) >> 1;
    if (segCount < 1) {
      continue;
    }
    const endPos = sub + 14 + (segCount - 1) * 2;
    const deltaPos = sub + 14 + 4 * segCount + 2 + (segCount - 1) * 2;
    if (deltaPos + 2 > view.byteLength || view.getUint16(endPos) !== 0xffff) {
      continue;
    }
    if (view.getInt16(deltaPos) !== 1) {
      view.setInt16(deltaPos, 1);
      changed = true;
    }
  }
  return changed;
}

function writeTag(data, offset, tag) {
  for (let i = 0; i < 4; i++) {
    data[offset + i] = tag.charCodeAt(i);
  }
}

function tableChecksum(data, offset, length) {
  let sum = 0;
  const end = offset + length;
  const padded = offset + ((length + 3) & ~3);
  for (let i = offset; i < padded; i += 4) {
    const b0 = i < end ? data[i] : 0;
    const b1 = i + 1 < end ? data[i + 1] : 0;
    const b2 = i + 2 < end ? data[i + 2] : 0;
    const b3 = i + 3 < end ? data[i + 3] : 0;
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0;
  }
  return sum;
}

async function loadImages(images) {
  const bitmaps = new Map();
  for (const [id, image] of images) {
    if (!image.bytes) {
      continue;
    }
    try {
      const blob = new Blob([image.bytes], { type: image.type });
      bitmaps.set(id, await createImageBitmap(blob));
    } catch (error) {
      bitmaps.set(id, null);
    }
  }
  return bitmaps;
}

function loadSeals(files, ofdXml, ofdPath) {
  const seals = [];
  const sigLoc = childText(ofdXml, "Signatures");
  if (!sigLoc) {
    return seals;
  }
  const sigPath = resolvePath(parentPath(ofdPath), sigLoc);
  const sigBytes = files.get(sigPath);
  if (!sigBytes) {
    return seals;
  }
  const sigDir = parentPath(sigPath);
  for (const sig of elements(parseXml(sigBytes), "Signature")) {
    const sigFile = resolvePath(sigDir, attr(sig, "BaseLoc"));
    const xmlBytes = files.get(sigFile);
    if (!xmlBytes) {
      continue;
    }
    const xml = parseXml(xmlBytes);
    const sealEl = elements(xml, "Seal")[0];
    const sealLoc = sealEl ? childText(sealEl, "BaseLoc") : "";
    const picture = sealLoc
      ? extractSealPicture(files.get(resolvePath(parentPath(sigFile), sealLoc)))
      : null;
    for (const stamp of elements(xml, "StampAnnot")) {
      seals.push({
        pageId: attr(stamp, "PageRef"),
        boundary: parseNums(attr(stamp, "Boundary")),
        bytes: picture ? picture.bytes : null,
        mime: picture ? picture.mime : "",
      });
    }
  }
  return seals;
}

async function loadSealBitmaps(seals) {
  const loaded = [];
  for (const seal of seals) {
    loaded.push({
      pageId: seal.pageId,
      boundary: seal.boundary,
      bitmap: await sealImageBitmap(seal.bytes, seal.mime),
    });
  }
  return loaded;
}

async function sealImageBitmap(bytes, mime) {
  if (!bytes) {
    return null;
  }
  try {
    if (mime === "application/ofd") {
      const nested = await unzip(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      for (const [name, file] of nested) {
        const ext = name.split(".").pop().toLowerCase();
        const type = imageMime(ext);
        if (type) {
          return await createImageBitmap(new Blob([file], { type: type }));
        }
      }
      return null;
    }
    return await createImageBitmap(new Blob([bytes], { type: mime || "application/octet-stream" }));
  } catch (error) {
    return null;
  }
}

function imageMime(ext) {
  if (ext === "gif") return "image/gif";
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "bmp") return "image/bmp";
  return "";
}

function extractSealPicture(bytes) {
  if (!bytes || bytes.length < 8) {
    return null;
  }
  const pictures = [];
  function visit(start, end, depth) {
    let offset = start;
    while (offset < end && depth < 8) {
      const node = readDer(bytes, offset, end);
      if (!node) {
        return;
      }
      if (node.tag === 0x30) {
        const children = readDerChildren(bytes, node.start, node.next);
        if (children.length >= 2 && children[0].tag === 0x16 && children[1].tag === 0x04) {
          const type = decodeLatin(bytes, children[0].start, children[0].length).toLowerCase();
          const mime = type === "ofd" ? "application/ofd" : imageMime(type);
          if (mime) {
            pictures.push({
              mime: mime,
              bytes: bytes.slice(children[1].start, children[1].start + children[1].length),
            });
          }
        }
        visit(node.start, node.next, depth + 1);
      }
      offset = node.next;
    }
  }
  visit(0, bytes.length, 0);
  return pictures[0] || null;
}

function readDerChildren(bytes, start, end) {
  const children = [];
  let offset = start;
  while (offset < end) {
    const node = readDer(bytes, offset, end);
    if (!node) {
      break;
    }
    children.push(node);
    offset = node.next;
  }
  return children;
}

function readDer(bytes, offset, end) {
  if (offset >= end) {
    return null;
  }
  let cursor = offset;
  const tag = bytes[cursor++];
  if (cursor >= end) {
    return null;
  }
  let length = bytes[cursor++];
  if (length & 0x80) {
    const count = length & 0x7f;
    if (!count || cursor + count > end) {
      return null;
    }
    length = 0;
    for (let i = 0; i < count; i++) {
      length = length * 256 + bytes[cursor++];
    }
  }
  if (cursor + length > end) {
    return null;
  }
  return { tag: tag, start: cursor, length: length, next: cursor + length };
}

function decodeLatin(bytes, start, length) {
  let text = "";
  for (let i = 0; i < length; i++) {
    text += String.fromCharCode(bytes[start + i]);
  }
  return text;
}

function drawPage(canvas, pageXml, box, scale, families, images, seals, warnings, annotations, files, pageId, pageIndex, archiveStamp) {
  const pageW = box[2];
  const pageH = box[3];
  if (!(pageW > 0) || !(pageH > 0)) {
    return;
  }
  const cssW = pageW * scale;
  const cssH = pageH * scale;
  const dpr = window.devicePixelRatio || 1;
  const longest = Math.max(cssW, cssH);
  // 限制位图像素，避免高分屏把十几页同时放大后撑满内存，导致预览和打印都卡住。
  const bitmapScale = Math.min(dpr, longest > 2400 ? 2400 / longest : dpr);
  canvas.width = Math.max(1, Math.ceil(cssW * bitmapScale));
  canvas.height = Math.max(1, Math.ceil(cssH * bitmapScale));
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return;
  }
  ctx.setTransform(bitmapScale, 0, 0, bitmapScale, 0, 0);
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, cssW, cssH);
  for (const layer of elements(pageXml, "Layer")) {
    drawContentNodes(ctx, layer.children, scale, families, images, warnings);
  }
  // 档号章不在页面正文里。Document.xml 指向 Annotations.xml，再按页指向
  // Annotation.xml。Appearance 里的图用页面毫米坐标，资源 ID 指向文档资源里的图片。
  drawAnnotations(ctx, annotations || [], files, pageId, scale, families, images, warnings);
  // 签章外观不在页面内容里。位置来自 StampAnnot 的 Boundary（毫米），
  // 图像来自 Seal.esl 里的印章图片，叠在页面内容之上。
  for (const seal of seals) {
    if (!seal.bitmap || seal.boundary.length < 4) {
      noteOnce(warnings, "有电子签章未能绘制");
      continue;
    }
    const [x, y, w, h] = seal.boundary;
    ctx.drawImage(seal.bitmap, x * scale, y * scale, w * scale, h * scale);
  }
  // 参数章只补文件里没有的档号章。已有 Stamp 注释时不再叠一张，避免右上角出现两枚章。
  if (archiveStamp && archiveStamp.page === pageIndex && !pageHasStampAnnot(annotations, files, pageId)) {
    drawArchiveStamp(ctx, box, scale, archiveStamp);
  }
}

function pageHasStampAnnot(annotations, files, pageId) {
  if (!files) {
    return false;
  }
  for (const item of annotations || []) {
    if (item.pageId !== pageId) {
      continue;
    }
    const bytes = files.get(item.href);
    if (!bytes) {
      continue;
    }
    try {
      for (const annot of elements(parseXml(bytes), "Annot")) {
        const type = attr(annot, "Type");
        const subtype = attr(annot, "Subtype");
        if (type === "Stamp" || /stamp/i.test(subtype)) {
          return true;
        }
      }
    } catch (error) {
      continue;
    }
  }
  return false;
}

function drawArchiveStamp(ctx, box, scale, stamp) {
  const metrics = measureStamp(stamp, scale);
  if (!metrics || !(box[2] > 0)) {
    return;
  }
  const x = Math.max(0, box[2] - metrics.marginRight - metrics.tableWidth);
  const y = Math.max(0, Math.min(metrics.marginTop, box[3] - metrics.tableHeight));
  paintStampTable(ctx, metrics, scale, x, y);
}

function measureStamp(stamp, scale) {
  const rows = (stamp.rows || []).filter((row) => Array.isArray(row) && row.length);
  if (!rows.length) {
    return null;
  }
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) {
    return null;
  }
  const fontMm = stamp.fontSize;
  const padX = 1.6;
  const padY = 1;
  ctx.font = fontMm * scale + "px SimHei, \"Microsoft YaHei\", DengXian, sans-serif";
  const columnWidth = [];
  const columns = Math.max(...rows.map((row) => row.length));
  for (let column = 0; column < columns; column++) {
    let width = fontMm * 2 + padX * 2;
    for (const row of rows) {
      const text = row[column] == null ? "" : String(row[column]);
      width = Math.max(width, ctx.measureText(text).width / scale + padX * 2);
    }
    columnWidth.push(width);
  }
  const rowHeight = fontMm + padY * 2;
  return {
    rows,
    columnWidth,
    rowHeight,
    tableWidth: columnWidth.reduce((sum, width) => sum + width, 0),
    tableHeight: rowHeight * rows.length,
    color: stamp.color,
    lineWidth: Math.max(0.35 * scale, 1),
    marginTop: stamp.marginTop,
    marginRight: stamp.marginRight,
    fontMm,
  };
}

function paintStampTable(ctx, metrics, scale, originX, originY) {
  ctx.save();
  ctx.font = metrics.fontMm * scale + "px SimHei, \"Microsoft YaHei\", DengXian, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(originX * scale, originY * scale, metrics.tableWidth * scale, metrics.tableHeight * scale);
  ctx.strokeStyle = metrics.color;
  ctx.fillStyle = metrics.color;
  ctx.lineWidth = metrics.lineWidth;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  // 每个格子单独描边时，相邻边会画两遍，中间线就比外框粗。这里外框和分隔线都只画一次。
  ctx.beginPath();
  ctx.rect(originX * scale, originY * scale, metrics.tableWidth * scale, metrics.tableHeight * scale);
  let edgeX = originX;
  metrics.columnWidth.forEach((width, index) => {
    edgeX += width;
    if (index < metrics.columnWidth.length - 1) {
      const x = edgeX * scale;
      ctx.moveTo(x, originY * scale);
      ctx.lineTo(x, (originY + metrics.tableHeight) * scale);
    }
  });
  let edgeY = originY;
  for (let index = 0; index < metrics.rows.length - 1; index++) {
    edgeY += metrics.rowHeight;
    const y = edgeY * scale;
    ctx.moveTo(originX * scale, y);
    ctx.lineTo((originX + metrics.tableWidth) * scale, y);
  }
  ctx.stroke();
  let rowTop = originY;
  for (const row of metrics.rows) {
    let cellLeft = originX;
    metrics.columnWidth.forEach((width, column) => {
      const text = row[column] == null ? "" : String(row[column]);
      ctx.fillText(text, (cellLeft + width / 2) * scale, (rowTop + metrics.rowHeight / 2) * scale);
      cellLeft += width;
    });
    rowTop += metrics.rowHeight;
  }
  ctx.restore();
}

function drawContentNodes(ctx, nodes, scale, families, images, warnings) {
  for (const node of nodes) {
    if (node.nodeType !== 1) {
      continue;
    }
    if (node.localName === "TextObject") {
      drawText(ctx, node, scale, families);
    } else if (node.localName === "PathObject") {
      drawPath(ctx, node, scale);
    } else if (node.localName === "ImageObject") {
      drawImageObject(ctx, node, scale, images, warnings);
    } else if (node.localName === "CompositeObject" || node.localName === "PageBlock") {
      noteOnce(warnings, "遇到复合对象，第一版未绘制");
    }
  }
}

function drawAnnotations(ctx, annotations, files, pageId, scale, families, images, warnings) {
  if (!files) {
    return;
  }
  for (const item of annotations) {
    if (item.pageId !== pageId) {
      continue;
    }
    const bytes = files.get(item.href);
    if (!bytes) {
      noteOnce(warnings, "有注释未能绘制");
      continue;
    }
    let xml;
    try {
      xml = parseXml(bytes);
    } catch (error) {
      noteOnce(warnings, "有注释未能绘制");
      continue;
    }
    for (const annot of elements(xml, "Annot")) {
      if (attr(annot, "Visible") === "false") {
        continue;
      }
      for (const appearance of elements(annot, "Appearance")) {
        drawContentNodes(ctx, appearance.children, scale, families, images, warnings);
      }
    }
  }
}

function loadAnnotations(files, docXml, docDir) {
  const loc = childText(docXml, "Annotations");
  if (!loc) {
    return [];
  }
  const listPath = resolvePath(docDir, loc);
  const bytes = files.get(listPath);
  if (!bytes) {
    return [];
  }
  const listDir = parentPath(listPath);
  return [...elements(parseXml(bytes), "Page")].flatMap((page) => {
    const href = resolvePath(listDir, childText(page, "FileLoc"));
    const pageId = attr(page, "PageID");
    return href && pageId ? [{ pageId, href }] : [];
  });
}

function drawText(ctx, node, scale, families) {
  const boundary = parseNums(attr(node, "Boundary"));
  if (boundary.length < 4) {
    return;
  }
  const [bx, by] = boundary;
  const size = Number(attr(node, "Size")) || 3.5;
  const family = families.get(attr(node, "Font")) || "serif";
  const fill = colorOf(elements(node, "FillColor")[0], "#000000");
  const ctm = parseNums(attr(node, "CTM"));
  ctx.save();
  ctx.fillStyle = fill;
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = fontPx(size, ctm, scale) + "px " + family;
  for (const code of elements(node, "TextCode")) {
    const chars = Array.from(code.textContent || "");
    const deltas = parseDeltas(attr(code, "DeltaX"));
    let x = Number(attr(code, "X")) || 0;
    const y = Number(attr(code, "Y")) || 0;
    chars.forEach((ch, index) => {
      const point = transformPoint(ctm, x, y);
      ctx.fillText(ch, (bx + point[0]) * scale, (by + point[1]) * scale);
      x += deltas[index] != null ? deltas[index] : size;
    });
  }
  ctx.restore();
}

function drawPath(ctx, node, scale) {
  const boundary = parseNums(attr(node, "Boundary"));
  if (boundary.length < 4) {
    return;
  }
  const data = childText(node, "AbbreviatedData");
  const commands = parsePath(data);
  if (!commands.length) {
    return;
  }
  const [bx, by] = boundary;
  const ctm = parseNums(attr(node, "CTM"));
  const stroke = flag(node, "Stroke", true);
  const fill = flag(node, "Fill", false);
  ctx.save();
  ctx.beginPath();
  let moved = false;
  for (const command of commands) {
    if (command.op === "M") {
      const [x, y] = transformPoint(ctm, command.x, command.y);
      ctx.moveTo((bx + x) * scale, (by + y) * scale);
      moved = true;
    } else if (command.op === "L") {
      const [x, y] = transformPoint(ctm, command.x, command.y);
      if (!moved) {
        ctx.moveTo((bx + x) * scale, (by + y) * scale);
        moved = true;
      } else {
        ctx.lineTo((bx + x) * scale, (by + y) * scale);
      }
    } else if (command.op === "C") {
      ctx.closePath();
    }
  }
  if (fill) {
    ctx.fillStyle = colorOf(elements(node, "FillColor")[0], "#000000");
    ctx.fill();
  }
  if (stroke) {
    const width = Number(attr(node, "LineWidth")) || 0.353;
    ctx.strokeStyle = colorOf(elements(node, "StrokeColor")[0], "#000000");
    ctx.lineWidth = Math.max(width * scale, 0.5);
    ctx.lineJoin = joinOf(attr(node, "Join"));
    ctx.lineCap = capOf(attr(node, "Cap"));
    ctx.stroke();
  }
  ctx.restore();
}

function drawImageObject(ctx, node, scale, images, warnings) {
  const boundary = parseNums(attr(node, "Boundary"));
  const bitmap = images.get(attr(node, "ResourceID"));
  if (boundary.length < 4 || !bitmap) {
    noteOnce(warnings, "有图片未能绘制");
    return;
  }
  const [bx, by, bw, bh] = boundary;
  const ctm = parseNums(attr(node, "CTM"));
  ctx.save();
  ctx.translate(bx * scale, by * scale);
  if (ctm.length === 6) {
    const [a, b, c, d, e, f] = ctm;
    ctx.transform(a * scale, b * scale, c * scale, d * scale, e * scale, f * scale);
    ctx.drawImage(bitmap, 0, 0, 1, 1);
  } else {
    ctx.drawImage(bitmap, 0, 0, bw * scale, bh * scale);
  }
  ctx.restore();
}

function parseDeltas(text) {
  const tokens = String(text || "").trim().split(/\s+/).filter(Boolean);
  const deltas = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "g" || tokens[i] === "G") {
      const count = Number(tokens[++i]);
      const value = Number(tokens[++i]);
      for (let n = 0; n < count; n++) {
        deltas.push(value);
      }
    } else {
      const value = Number(tokens[i]);
      if (!Number.isNaN(value)) {
        deltas.push(value);
      }
    }
  }
  return deltas;
}

function parsePath(data) {
  const tokens = String(data || "").trim().split(/\s+/).filter(Boolean);
  const commands = [];
  for (let i = 0; i < tokens.length; i++) {
    const op = tokens[i];
    if (op === "M" || op === "L") {
      commands.push({ op, x: Number(tokens[++i]), y: Number(tokens[++i]) });
    } else if (op === "C") {
      commands.push({ op });
    } else if (op === "Q" || op === "B" || op === "A") {
      break;
    }
  }
  return commands;
}

function parseNums(text) {
  if (!text) {
    return [];
  }
  return text.trim().split(/\s+/).map(Number);
}

function transformPoint(ctm, x, y) {
  if (ctm.length !== 6) {
    return [x, y];
  }
  const [a, b, c, d, e, f] = ctm;
  return [a * x + c * y + e, b * x + d * y + f];
}

function fontPx(sizeMm, ctm, scale) {
  const factor = ctm.length === 6 ? Math.hypot(ctm[0], ctm[1]) || 1 : 1;
  return sizeMm * factor * scale;
}

function colorOf(node, fallback) {
  if (!node) {
    return fallback;
  }
  const value = attr(node, "Value");
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length === 1 && !Number.isNaN(parts[0])) {
    return "rgb(" + parts[0] + "," + parts[0] + "," + parts[0] + ")";
  }
  if (parts.length >= 3 && parts.slice(0, 3).every((n) => !Number.isNaN(n))) {
    const alpha = parts.length >= 4 ? parts[3] / 255 : 1;
    return "rgba(" + parts[0] + "," + parts[1] + "," + parts[2] + "," + alpha + ")";
  }
  return fallback;
}

function flag(node, name, fallback) {
  const value = attr(node, name);
  if (!value) {
    return fallback;
  }
  return value === "true";
}

function joinOf(value) {
  const name = String(value || "miter").toLowerCase();
  if (name === "bevel" || name === "round") {
    return name;
  }
  return "miter";
}

function capOf(value) {
  const name = String(value || "butt").toLowerCase();
  if (name === "round" || name === "square") {
    return name;
  }
  return "butt";
}

function noteOnce(warnings, message) {
  if (!warnings.includes(message)) {
    warnings.push(message);
  }
}

export async function buildOfd(model) {
  const files = new Map(model.files);
  const stamp = model.archiveStamp;
  const page = stamp && model.pages[stamp.page];
  if (stamp && page && !pageHasStampAnnot(model.annotations, files, page.id)) {
    await embedArchiveStamp(files, model, stamp, page);
  }
  return zipFiles(files);
}

async function embedArchiveStamp(files, model, stamp, page) {
  const pagePath = resolvePath(model.docDir, page.href);
  const pageBytes = files.get(pagePath);
  const box = (pageBytes && readPhysicalBox(parseXml(pageBytes))) || model.box;
  const metrics = measureStamp(stamp, 8);
  if (!metrics) {
    return;
  }
  const x = Math.max(0, box[2] - metrics.marginRight - metrics.tableWidth);
  const y = Math.max(0, Math.min(metrics.marginTop, box[3] - metrics.tableHeight));
  const png = await renderStampPng(stamp);
  let docXml = decodeText(files.get(model.docPath));
  let nextId = maxUnitId(files, docXml) + 1;
  const mediaId = nextId++;
  const imageId = nextId++;
  const appearanceId = nextId++;
  const annotId = nextId++;
  docXml = ensureDocumentRes(docXml, files, model.docDir, mediaId, png.bytes);
  docXml = ensureStampAnnotation(docXml, files, model.docDir, page.id, {
    annotId,
    appearanceId,
    imageId,
    mediaId,
    pageW: box[2],
    pageH: box[3],
    x: x - png.padMm,
    y: y - png.padMm,
    w: png.widthMm,
    h: png.heightMm,
  });
  docXml = setMaxUnitId(docXml, annotId);
  files.set(model.docPath, encodeXml(docXml));
}

async function renderStampPng(stamp) {
  const scale = 8;
  const metrics = measureStamp(stamp, scale);
  // 线条以边框路径为中心。图片若刚好等于表格，外圈有一半会被切掉，外框就比内部分隔线细。
  const pad = Math.ceil(metrics.lineWidth);
  const widthPx = Math.ceil(metrics.tableWidth * scale) + pad * 2;
  const heightPx = Math.ceil(metrics.tableHeight * scale) + pad * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, widthPx);
  canvas.height = Math.max(1, heightPx);
  paintStampTable(canvas.getContext("2d"), metrics, scale, pad / scale, pad / scale);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return {
    bytes: new Uint8Array(await blob.arrayBuffer()),
    padMm: pad / scale,
    widthMm: canvas.width / scale,
    heightMm: canvas.height / scale,
  };
}

function ensureDocumentRes(docXml, files, docDir, mediaId, png) {
  const existing = tagText(docXml, "DocumentRes");
  const media = `<ofd:MultiMedia ID="${mediaId}" Type="Image" Format="PNG"><ofd:MediaFile>caoye-stamp.png</ofd:MediaFile></ofd:MultiMedia>`;
  if (existing) {
    const resPath = resolvePath(docDir, existing);
    const resXml = decodeText(files.get(resPath));
    const base = /BaseLoc="([^"]*)"/.exec(resXml);
    const baseLoc = base ? base[1] : ".";
    const pngPath = resolvePath(resolvePath(parentPath(resPath), baseLoc), "caoye-stamp.png");
    files.set(pngPath, png);
    files.set(resPath, encodeXml(insertXml(resXml, ["</ofd:MultiMedias>", "</MultiMedias>", "</ofd:Res>", "</Res>"], mediaWrap(resXml, media))));
    return docXml;
  }
  const resPath = (docDir ? docDir + "/" : "") + "DocumentRes.xml";
  files.set(resPath, encodeXml(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<ofd:Res xmlns:ofd=\"http://www.ofdspec.org/2016\" BaseLoc=\"Res\">" +
    "<ofd:MultiMedias>" + media + "</ofd:MultiMedias></ofd:Res>"
  ));
  files.set((docDir ? docDir + "/" : "") + "Res/caoye-stamp.png", png);
  const withRes = insertAfter(docXml, ["</ofd:PublicRes>", "</PublicRes>"], "<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>");
  return withRes === docXml ? insertXml(docXml, ["</ofd:CommonData>", "</CommonData>"], "<ofd:DocumentRes>DocumentRes.xml</ofd:DocumentRes>") : withRes;
}

function mediaWrap(resXml, media) {
  if (/MultiMedias/.test(resXml)) {
    return media;
  }
  return "<ofd:MultiMedias>" + media + "</ofd:MultiMedias>";
}

function ensureStampAnnotation(docXml, files, docDir, pageId, place) {
  const image = `<ofd:ImageObject ID="${place.imageId}" ResourceID="${place.mediaId}" Boundary="0 0 ${mmText(place.pageW)} ${mmText(place.pageH)}" CTM="${mmText(place.w)} 0 0 ${mmText(place.h)} ${mmText(place.x)} ${mmText(place.y)}" Alpha="255"/>`;
  const annot = `<ofd:Annot ID="${place.annotId}" Type="Stamp" Creator="caoye-ofd" Subtype="ArchiveStamp"><ofd:Appearance ID="${place.appearanceId}">${image}</ofd:Appearance></ofd:Annot>`;
  const existing = tagText(docXml, "Annotations");
  if (existing) {
    const listPath = resolvePath(docDir, existing);
    const listXml = decodeText(files.get(listPath));
    const pageTag = new RegExp("PageID=\"" + pageId + "\"[\\s\\S]*?<[^>]*FileLoc>([^<]+)");
    const found = pageTag.exec(listXml);
    if (found) {
      const annotPath = resolvePath(parentPath(listPath), found[1].trim());
      const annotXml = decodeText(files.get(annotPath));
      files.set(annotPath, encodeXml(insertXml(annotXml, ["</ofd:PageAnnot>", "</PageAnnot>"], annot)));
      return docXml;
    }
    const fileLoc = "Annots/Stamp_" + pageId + ".xml";
    files.set(resolvePath(docDir, fileLoc), encodeXml(pageAnnotXml(annot)));
    files.set(listPath, encodeXml(insertXml(listXml, ["</ofd:Annotations>", "</Annotations>"], `<ofd:Page PageID="${pageId}"><ofd:FileLoc>${fileLoc}</ofd:FileLoc></ofd:Page>`)));
    return docXml;
  }
  const fileLoc = "Annots/Stamp_" + pageId + ".xml";
  files.set((docDir ? docDir + "/" : "") + fileLoc, encodeXml(pageAnnotXml(annot)));
  files.set((docDir ? docDir + "/" : "") + "Annotations.xml", encodeXml(
    "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    `<ofd:Annotations xmlns:ofd="http://www.ofdspec.org/2016"><ofd:Page PageID="${pageId}"><ofd:FileLoc>${fileLoc}</ofd:FileLoc></ofd:Page></ofd:Annotations>`
  ));
  return insertXml(docXml, ["</ofd:Document>", "</Document>"], "<ofd:Annotations>Annotations.xml</ofd:Annotations>");
}

function pageAnnotXml(annot) {
  return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
    "<ofd:PageAnnot xmlns:ofd=\"http://www.ofdspec.org/2016\">" + annot + "</ofd:PageAnnot>";
}

function tagText(xml, localName) {
  const match = new RegExp("<[^>]*\\b" + localName + "[^>]*>([^<]+)</[^>]*" + localName + ">").exec(xml);
  return match ? match[1].trim() : "";
}

function insertXml(xml, closers, insertion) {
  for (const closer of closers) {
    const index = xml.lastIndexOf(closer);
    if (index >= 0) {
      return xml.slice(0, index) + insertion + xml.slice(index);
    }
  }
  return xml + insertion;
}

function insertAfter(xml, markers, insertion) {
  for (const marker of markers) {
    const index = xml.lastIndexOf(marker);
    if (index >= 0) {
      const end = index + marker.length;
      return xml.slice(0, end) + insertion + xml.slice(end);
    }
  }
  return xml;
}

function setMaxUnitId(xml, id) {
  if (/MaxUnitID/.test(xml)) {
    return xml.replace(/(<[^>]*MaxUnitID>)(\d+)(<\/[^>]*MaxUnitID>)/, "$1" + id + "$3");
  }
  return insertXml(xml, ["</ofd:CommonData>", "</CommonData>"], "<ofd:MaxUnitID>" + id + "</ofd:MaxUnitID>");
}

function maxUnitId(files, docXml) {
  let max = 0;
  const listed = /<[^>]*MaxUnitID>(\d+)/.exec(docXml);
  if (listed) {
    max = Number(listed[1]);
  }
  for (const [name, bytes] of files) {
    if (!/\.xml$/i.test(name)) {
      continue;
    }
    const text = decodeText(bytes);
    const pattern = /\bID="(\d+)"/g;
    let match = pattern.exec(text);
    while (match) {
      max = Math.max(max, Number(match[1]));
      match = pattern.exec(text);
    }
  }
  return max;
}

function mmText(value) {
  return String(Math.round(value * 1000) / 1000);
}

function encodeXml(text) {
  return new TextEncoder().encode(text);
}

async function zipFiles(files) {
  const names = [...files.keys()].sort((left, right) => {
    if (left === "OFD.xml") {
      return -1;
    }
    if (right === "OFD.xml") {
      return 1;
    }
    return left < right ? -1 : 1;
  });
  const parts = [];
  const entries = [];
  let offset = 0;
  for (const name of names) {
    const bytes = files.get(name);
    const compressed = await deflateRaw(bytes);
    const method = compressed ? 8 : 0;
    const payload = compressed || bytes;
    const crc = crc32(bytes);
    const nameBytes = new TextEncoder().encode(name);
    const header = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 0x0800, true);
    view.setUint16(8, method, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, payload.length, true);
    view.setUint32(22, bytes.length, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    parts.push(header, payload);
    entries.push({ nameBytes, method, crc, compSize: payload.length, size: bytes.length, offset });
    offset += header.length + payload.length;
  }
  const centralStart = offset;
  for (const entry of entries) {
    const header = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(8, 0x0800, true);
    view.setUint16(10, entry.method, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.compSize, true);
    view.setUint32(24, entry.size, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint32(42, entry.offset, true);
    header.set(entry.nameBytes, 46);
    parts.push(header);
    offset += header.length;
  }
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  parts.push(end);
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of parts) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out.buffer;
}

async function deflateRaw(bytes) {
  if (!bytes.length || typeof CompressionStream === "undefined") {
    return null;
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  const compressed = new Uint8Array(await new Response(stream).arrayBuffer());
  return compressed.length < bytes.length ? compressed : null;
}

let crcTable = null;

function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index++) {
      let value = index;
      for (let bit = 0; bit < 8; bit++) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
