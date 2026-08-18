// i18n.js — Chinese interface for the Technician role.
//
// WHY THIS EXISTS
// Our technicians work in Chinese. Sales and Purchaser keep working in English,
// so this is not a whole-app translation — it switches on only when the phone's
// role (localStorage "om_role") is "tech".
//
// HOW IT WORKS
// app.js rebuilds big chunks of the screen with innerHTML as you use the app, so
// translating once at startup would not be enough. Instead this file watches the
// page and re-translates whatever appears. None of app.js's logic had to change:
// the English text stays the source of truth, and this layer swaps what is shown.
//
// SAFETY RULE — EXACT MATCHES ONLY
// A phrase is translated only when the WHOLE text matches a dictionary entry (or
// one of the anchored patterns below). That is deliberate: part descriptions,
// item codes, company names and customer notes come from AutoCount and from our
// own database, and they must never be altered. They will never match an entry.
//
// TO ADD OR FIX A TRANSLATION
// Add a line to DICT below —  "English exactly as shown": "中文",
// then bump CACHE in sw.js so the phones pick up the new file.

(function () {
  "use strict";

  var ROLE_KEY = "om_role";

  // ---- Dictionary --------------------------------------------------------
  // The left side must match the English on screen EXACTLY, punctuation included.
  var DICT = {
    // ---- Shared / topbar ----
    "Home": "首页",
    "Search": "搜索",
    "Save": "保存",
    "Saved": "已保存",
    "Add": "添加",
    "Done": "完成",
    "Close": "关闭",
    "Got it": "知道了",
    "Loading…": "加载中…",

    // ---- Role screen ----
    "Service desk": "服务台",
    "Who is using the app?": "谁在使用本应用？",
    "Sales Staff": "销售人员",
    "Register, close and view slips": "登记、结单、查看服务单",
    "Technician 技术员": "技术员",
    "Technician": "技术员",
    "Scan parts onto a service slip": "扫描零件到服务单",
    "Purchaser": "采购员",
    "Slips, parts and purchasing": "服务单、零件与采购",

    // ---- Home ----
    "What would you like to do?": "请选择操作",
    "New Service": "新建服务单",
    "Register a customer's machines": "登记客户的机器",
    "Open Service": "处理服务单",
    "Close Service": "结束服务单",
    "Record DO/CS/INV and close": "记录 DO/CS/INV 并结单",
    "View Slips": "查看服务单",
    "Look up any service slip": "查询任何服务单",
    "Find Part": "查找零件",
    "Check part location and stock": "查看零件位置与库存",
    "Requested Parts": "已申请零件",
    "Parts requested for reordering": "申请补货的零件",
    "Switch role": "切换身份",

    // ---- Find Part ----
    "Parts": "零件",
    "Search by description or part no.": "按名称或零件编号搜索",
    "e.g. clutch, carburetor, SZEN 140…": "例如：clutch、carburetor、SZEN 140…",
    "Scan QR Code": "扫描二维码",
    "Point at a QR code": "对准二维码",
    "Stop scanning": "停止扫描",
    "Order more": "申请补货",
    "Part No.": "零件编号",
    "Description": "名称",
    "Location / Shelf": "位置 / 货架",
    "Bal. Qty": "库存数量",
    "Current Qty": "现有数量",
    "Qty Requested": "申请数量",
    "Looking up stock…": "正在查询库存…",
    "No matching parts": "没有符合的零件",
    "Search failed": "搜索失败",
    "Lookup failed": "查询失败",
    "Unit price": "单价",
    "No price — enter one": "无价格 — 请输入",

    // ---- Order-more modal / purchasing ----
    "Order quantity": "申请数量",
    "Requester": "申请人",
    "Your name": "你的名字",
    "Submit request": "提交申请",
    "Enter an order quantity": "请输入申请数量",
    "Enter the requester's name": "请输入申请人姓名",
    "Request submitted": "申请已提交",
    "Mark ordered": "标记为已订购",
    "Marked as ordered": "已标记为已订购",
    "Purchasing": "采购",
    "Requested parts": "已申请零件",
    "Loading requests…": "正在加载申请…",
    "No parts have been requested": "目前没有零件申请",

    // ---- Open Service (slip list) ----
    "Open service": "处理服务单",
    "Pick a service slip": "选择服务单",
    "Slip number or company…": "服务单号或公司名称…",
    "Loading slips…": "正在加载服务单…",
    "No open slips": "没有待处理的服务单",
    "No slips match": "没有符合的服务单",
    "No matching slips": "没有符合的服务单",
    "No slips yet": "暂无服务单",
    "Keep typing to narrow results…": "继续输入以缩小范围…",

    // ---- Slip detail ----
    "← All slips": "← 所有服务单",
    "Machines — tap one to work on it": "机器 — 点击一台开始作业",
    "Need to Quote": "需要报价",
    "Mark as Quoted": "标记为已报价",
    "Close w/o Quote": "无需报价结单",
    "Slip total": "服务单总额",
    "Create Sales Order": "生成销售订单",
    "Need Repair": "需要维修",
    "Machine total": "机器总额",
    "Machine total:": "机器总额：",
    "No quote needed — carry on": "无需报价 — 请继续",
    "Continuing without quote": "继续，无需报价",
    "Marked: Need to Quote": "已标记：需要报价",
    "Marked: Quoted": "已标记：已报价",

    // ---- Machine modal ----
    "Machine": "机器",
    "Select your name…": "选择你的名字…",
    "Pick your name first": "请先选择你的名字",
    "Upload photos": "上传照片",
    "Type code": "手动输入",
    "Take a photo of each barcode, then upload them all at once.": "为每个条码拍一张照片，然后一次全部上传。",
    "📷 Upload barcode photos": "📷 上传条码照片",
    "Point at a barcode — tap the view to focus": "对准条码 — 点击画面对焦",
    "Camera blocked — switch to Type code": "相机被阻止 — 请改用手动输入",
    "Camera not ready": "相机未就绪",
    "Restart camera": "重启相机",
    "Part number or barcode": "零件编号或条码",
    "e.g. 525IB": "例如：525IB",
    "Parts on this machine": "本机器的零件",
    "Scan or type a part to add it to this machine.": "扫描或输入零件编号，添加到本机器。",
    "No parts yet": "暂无零件",
    "Repair comment": "维修说明",
    "(what was wrong, what was done)": "（问题是什么，做了什么）",
    "e.g. Carburettor clogged — cleaned and replaced fuel line.": "例如：化油器堵塞 — 已清洗并更换油管。",
    "Not saved yet — tap Save below": "尚未保存 — 请点击下方保存",
    "Line total": "小计",
    "Remove part": "移除零件",
    "Increase quantity": "增加数量",
    "Decrease quantity": "减少数量",

    // ---- View slips ----
    "View slips": "查看服务单",
    "Look up a service slip": "查询服务单",
    "Select any slip to see its full details.": "选择任何服务单查看完整内容。",
    "Service slip": "服务单",
    "Service Slip": "服务单",
    "No parts recorded.": "未记录零件。",
    "Closed with:": "结单编号：",
    "Share slip (PDF)": "分享服务单（PDF）",
    "Machines received:": "收到的机器：",
    "Contact No.": "联络电话",
    "Check & Service for all": "全部检查与保养",
    "Quote first": "先报价",
    "has comment": "有维修说明",

    // ---- Statuses (STATUS_LABEL in app.js) ----
    "Open": "待处理",
    "In Progress": "进行中",
    "Quoted": "已报价",
    "All Repaired": "全部修好",
    "Closed": "已结单",

    // ---- Photo upload ----
    "Retake the photos below — fill the frame with the barcode and hold the phone parallel to the label.":
      "请重拍以下照片 — 让条码填满画面，手机与标签保持平行。",

    // ---- Server messages that can reach the technician ----
    "Part not found.": "找不到此零件。",
    "Service slip not found": "找不到服务单",
    "Stock lookup failed.": "库存查询失败。",
    "Order not found": "找不到订单",
    "Missing code": "缺少零件编号",
    "AutoCount is not enabled.": "AutoCount 未启用。",
    "Failed to load requests": "加载申请失败"
  };

  // app.js renders dates as "18 Aug 2026" (formatDate). Rewrite them the way a
  // Chinese reader expects: 2026年8月18日.
  var MONTHS = {
    Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6,
    Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12
  };
  function cnDate(d, mon, y) {
    return y + "年" + MONTHS[mon] + "月" + Number(d) + "日";
  }
  var DATE = "(\\d{1,2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\\d{4})";

  // ---- Patterns ----------------------------------------------------------
  // For messages that carry a live value — a slip number, a count, a part name.
  // Anchored with ^...$ so they only fire on a complete match, and the value is
  // carried through untouched via $1 / $2. A replacement may also be a function
  // (used where a month name has to become a number).
  var PATTERNS = [
    // Dates, alone and inside the lines that carry them
    [new RegExp("^" + DATE + "$"), function (_, d, m, y) { return cnDate(d, m, y); }],
    [new RegExp("^Created: " + DATE + "$"), function (_, d, m, y) { return "创建日期：" + cnDate(d, m, y); }],
    [new RegExp("^on " + DATE + "$"), function (_, d, m, y) { return "于 " + cnDate(d, m, y); }],
    [new RegExp("^Slip (.+) · Created " + DATE + "$"),
      function (_, s, d, m, y) { return "服务单 " + s + " · 创建于 " + cnDate(d, m, y); }],
    [new RegExp("^(\\d+) machines? · " + DATE + "$"),
      function (_, n, d, m, y) { return n + " 台机器 · " + cnDate(d, m, y); }],

    // Counts and summaries
    [/^(\d+) machines?$/, "$1 台机器"],
    [/^(\d+) parts?$/, "$1 个零件"],
    [/^(\d+) parts? · has comment$/, "$1 个零件 · 有维修说明"],
    [/^(\d+) parts? · has comment · (.+)$/, "$1 个零件 · 有维修说明 · $2"],
    [/^(\d+) parts? · (\$[\d.,]+)$/, "$1 个零件 · $2"],
    [/^(\d+) parts? · (\d+) qty across (\d+) machines?$/, "$1 个零件 · 共 $2 件，分布于 $3 台机器"],
    [/^\((\d+) qty\)$/, "（$1 件）"],

    // Slip / machine context lines
    [/^· Slip (.+)$/, "· 服务单 $1"],
    [/^Machine: (.+) · Tech: (.+)$/, "机器：$1 · 技术员：$2"],

    [/^Added (.+) — tap Save when done$/, "已添加 $1 — 完成后请点击保存"],
    [/^Service slip (.+) created$/, "服务单 $1 已创建"],
    [/^Slip (.+) closed$/, "服务单 $1 已结单"],
    [/^Closed (.+)\. Returning home…$/, "$1 已结单。返回首页…"],
    [/^Sales Order (.+) created \((.+)\)$/, "销售订单 $1 已生成（$2）"],
    [/^Slip (.+) · (.+)$/, "服务单 $1 · $2"],
    [/^Contact: (.+)$/, "联络人：$1"],
    [/^Couldn't save comment: (.+)$/, "无法保存维修说明：$1"],
    [/^Couldn't build PDF: (.+)$/, "无法生成 PDF：$1"],
    [/^Request failed \((\d+)\)$/, "请求失败（$1）"],
    [/^(\d+) machines?$/, "$1 台机器"],
    [/^Reading photo (\d+) of (\d+)…$/, "正在读取第 $1 张，共 $2 张…"],
    [/^(\d+) of (\d+) photo\(s\) read successfully\.$/, "共 $2 张，成功读取 $1 张。"],
    [/^Couldn't read (\d+) of (\d+) photo\(s\)$/, "共 $2 张，有 $1 张无法读取"],
    [/^(\d+) scanned part\(s\) (?:have not|haven't) been saved\. Discard them\?$/, "有 $1 个已扫描的零件尚未保存。要放弃吗？"],
    [/^(\d+) prices? saved to AutoCount$/, "$1 个价格已保存到 AutoCount"],
    [/^Price save to AutoCount failed for: (.+)$/, "价格保存到 AutoCount 失败：$1"]
  ];

  // Attributes that hold text a person reads.
  var ATTRS = ["placeholder", "aria-label", "title", "alt"];

  // Never touch text inside these. Exact matching already protects live data;
  // this is a second line of defence around part codes and inline graphics.
  var SKIP = "script,style,svg,code,.mono,[data-no-i18n]";

  // Text that is already Chinese (plus punctuation/spaces) — skip early.
  var ALREADY_CN = /^[一-鿿\s，。：、（）？！—·]+$/;

  // ---- Engine ------------------------------------------------------------
  var enabled = false;
  var observer = null;
  var applying = false; // stops our own edits from re-triggering the observer

  function translate(text) {
    if (!text) return null;
    var trimmed = text.trim();
    if (!trimmed || ALREADY_CN.test(trimmed)) return null;

    // hasOwnProperty guard: without it, text such as "constructor" would find a
    // value on Object.prototype instead of missing cleanly.
    var hit = Object.prototype.hasOwnProperty.call(DICT, trimmed)
      ? DICT[trimmed]
      : undefined;
    if (hit === undefined) {
      for (var i = 0; i < PATTERNS.length; i++) {
        if (PATTERNS[i][0].test(trimmed)) {
          hit = trimmed.replace(PATTERNS[i][0], PATTERNS[i][1]);
          break;
        }
      }
    }
    if (hit === undefined || hit === trimmed) return null;
    // Preserve whatever whitespace surrounded the original. A function
    // replacement keeps "$" in the translation from being treated specially.
    return text.replace(trimmed, function () { return hit; });
  }

  function translateNode(node) {
    var el = node.parentElement;
    if (!el || el.closest(SKIP)) return;
    var out = translate(node.nodeValue);
    if (out !== null) node.nodeValue = out;
  }

  function translateAttrs(el) {
    if (!el || !el.getAttribute || (el.closest && el.closest(SKIP))) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var out = translate(v);
      if (out !== null) el.setAttribute(ATTRS[i], out);
    }
  }

  function walk(root) {
    if (!root) return;

    // Text nodes
    if (root.nodeType === 3) { translateNode(root); return; }

    var tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        var el = node.parentElement;
        if (!el || el.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var pending = [];
    var n;
    while ((n = tw.nextNode())) pending.push(n);
    for (var i = 0; i < pending.length; i++) {
      var out = translate(pending[i].nodeValue);
      if (out !== null) pending[i].nodeValue = out;
    }

    // Attributes (placeholders, aria-labels…)
    if (root.nodeType === 1) translateAttrs(root);
    if (root.querySelectorAll) {
      var els = root.querySelectorAll("*");
      for (var j = 0; j < els.length; j++) translateAttrs(els[j]);
    }
  }

  function apply(root) {
    if (!enabled || applying) return;
    applying = true;
    try { walk(root || document.body); } catch (e) { /* never break the app */ }
    applying = false;
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(function (records) {
      if (applying) return;
      applying = true;
      try {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === "characterData") {
            translateNode(r.target);
          } else if (r.type === "attributes") {
            translateAttrs(r.target);
          } else {
            for (var j = 0; j < r.addedNodes.length; j++) {
              var node = r.addedNodes[j];
              if (node.nodeType === 1 || node.nodeType === 3) walk(node);
            }
          }
        }
      } catch (e) { /* never break the app */ }
      applying = false;
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ATTRS
    });
  }

  function isTech() {
    try { return localStorage.getItem(ROLE_KEY) === "tech"; } catch (e) { return false; }
  }

  function boot() {
    if (!isTech()) return;
    enabled = true;
    document.documentElement.lang = "zh-Hans-SG";
    apply(document.body);
    start();
  }

  // The "unsaved parts" prompt uses the browser's own confirm() box, which the
  // observer cannot see — translate the question before it is shown.
  var nativeConfirm = window.confirm;
  window.confirm = function (msg) {
    if (enabled && typeof msg === "string") {
      var out = translate(msg);
      if (out !== null) msg = out;
    }
    return nativeConfirm.call(window, msg);
  };

  window.OM_I18N = {
    isEnabled: function () { return enabled; },
    refresh: function () { apply(document.body); },
    dict: DICT
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
