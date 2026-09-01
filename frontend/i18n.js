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
    "Note": "备注",
    "Add this part anyway?": "仍要添加此零件吗？",
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
    "Remarks": "备注",
    "(optional)": "（可选）",
    "e.g. Customer waiting, urgent": "例如：客户在等，加急",
    "Requester": "申请人",
    "Your name": "你的名字",
    "Submit request": "提交申请",
    "Confirm order": "确认申请",
    "Back": "返回",
    "Enter an order quantity": "请输入申请数量",
    "Enter the requester's name": "请输入申请人姓名",
    "Choose your name from the top bar first": "请先选择您的姓名",

    // ---- IPL (parts diagrams) ----
    // Technicians work off these more than anyone, so the whole screen is here.
    // "IPL" itself stays as it is: it is what the printed books are called and
    // what everyone in the workshop says.
    "Exploded views with live stock": "零件分解图与实时库存",
    "Parts catalogue": "零件目录",
    "Model, brand or machine type…": "型号、品牌或机器类型…",
    "Search models": "搜索型号",
    "Clear search": "清除搜索",
    "Machine type": "机器类型",
    "All": "全部",
    "Recently opened": "最近打开",
    "Change": "更换",
    "Reset": "重置",
    "Find in this figure": "在此图中查找",
    "Part number or description…": "零件编号或名称…",
    "No parts match that.": "没有符合的零件。",
    "Pinch to zoom · drag to move · tap a number": "双指缩放 · 拖动移动 · 点击数字",
    "Pinch to zoom · drag to move · pick a part from the list below": "双指缩放 · 拖动移动 · 从下方列表选择零件",
    "Pinch to zoom · drag to move · the parts tables are pages of their own in this book":
      "双指缩放 · 拖动移动 · 本手册的零件表是独立的页面",
    "Thermal Fogger": "热雾机",
    "Pinch to zoom · tap a number · scanned drawing, a few numbers may not respond":
      "双指缩放 · 点击数字 · 扫描图纸，少数数字可能无反应",
    "No IPLs installed yet": "尚未添加 IPL",
    "Ask John to add one.": "请联系 John 添加。",
    "Try the model number printed on the machine.": "请查看机器上标示的型号。",
    "Couldn't load that IPL": "无法加载该 IPL",
    "Not found in AutoCount under this number.": "在 AutoCount 中找不到此编号。",

    // Machine types. Also used by the filter chips and the chosen-model line,
    // through the patterns further down.
    "Chainsaw": "链锯",
    "Blower": "吹风机",
    "Hedge Trimmer": "绿篱机",
    "Pole Hedge Trimmer": "高枝绿篱机",
    "Brushcutter": "割灌机",
    "Robotic Mower": "智能割草机",
    "Lawn Mower": "草坪机",
    "Power Cutter": "切割机",
    "Outboard": "舷外机",
    "Engine": "发动机",
    "Other": "其他",
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
    // Shortened when it moved into the header beside Home.
    "← Slips": "← 服务单",
    "Machines — tap one to work on it": "机器 — 点击一台开始作业",
    "Need to Quote": "需要报价",
    "Quote all machines": "全部机器一起报价",
    "Quote the rest too": "其余机器也要报价",
    "Waiting to quote": "等待报价",
    "Quoted": "已报价",
    "Mark as Quoted": "标记为已报价",
    "No quote needed": "无需报价",
    "Slip total": "服务单总额",
    "Create Sales Order": "生成销售订单",
    "Need Repair": "需要维修",
    "Machine total": "机器总额",
    "Machine total:": "机器总额：",
    "No quote needed — carry on": "无需报价 — 请继续",
    "Continuing without quote": "继续，无需报价",
    "Marked: Need to Quote": "已标记：需要报价",
    "Marked: Quoted": "已标记：已报价",
    // A quote that has gone to the customer: nobody in the workshop can do
    // anything until they answer, which is what this has to say.
    "Waiting on Customer": "等待客户回复",
    "Waiting on customer": "等待客户回复",
    "Marked as quoted": "已标记为已报价",

    // ---- Machine modal ----
    "Machine": "机器",
    // The second header line on the machine screen: who is on it, and when the
    // machine came in.
    "Tech": "技术员",
    "Received": "收件",
    // What Sales came back with. The technician acts on this, so it is the one
    // set of strings here that must not be ambiguous.
    "Go ahead and repair": "可以维修",
    "The customer has confirmed this repair.": "客户已确认维修。",
    "Do not repair — condemned": "不要维修 — 已报废",
    "The customer does not want this machine repaired. Stop work on it.": "客户不维修这台机器。请停止作业。",
    "Repair": "维修",
    "Condemn": "报废",
    "Repair confirmed": "已确认维修",
    "Condemned": "已报废",
    "Tell me what the customer said": "客户回复时通知我",
    "Notify this device when Sales confirm a repair or condemn a machine": "销售确认维修或报废时通知本机",
    "On for this device": "本机已开启",
    "Turn on": "开启",
    "Turn off": "关闭",
    "This machine has not been sent for quoting.": "这台机器尚未送去报价。",
    "Send this machine for quoting": "把这台机器送去报价",
    "Send for quoting again": "再次送去报价",
    "Undo — still repairing": "撤销 — 仍在维修",
    "Sales have been told about this machine.": "已通知销售这台机器。",
    "Already sent to the customer.": "已发送给客户。",
    "Sent for quoting": "已送去报价",
    "Taken back": "已撤销",

    // ---- Moving a machine along ----
    // One machine, one state. These are the buttons a technician sees, and the
    // answer Sales bring back from the customer.
    "Quoted; waiting for their answer.": "已报价；等待客户回复。",
    "Carry on with the repair.": "可以继续维修。",
    "Undo — no quote needed": "撤销 — 无需报价",
    "Mark as quoted": "标记为已报价",
    "They said go ahead": "客户同意维修",
    "They said no — condemn": "客户不修 — 报废",
    "Send for quoting": "送去报价",
    "Repair it after all": "还是维修这台",
    "Still here — record where it goes before the slip can close.": "机器仍在店内 — 结单前请记录去向。",
    // Where a condemned machine went. The slip will not close until this is
    // answered, so it is asked plainly.
    "What happened to it?": "这台机器怎么处理？",
    "Where did it go?": "机器去向？",
    "Recorded:": "已记录：",
    "Not yet collected": "尚未取回",
    "Customer collected it": "客户已取回",
    "Customer collected": "客户已取回",
    "We disposed of it": "我们已处理掉",
    "Disposed of": "已处理掉",
    "Condemned — technician notified": "已报废 — 已通知技工",
    "Repair confirmed — technician notified": "已确认维修 — 已通知技工",
    "Quoted — waiting on the customer": "已报价 — 等待客户回复",
    "Hold off until they say yes or no.": "请等客户答复后再动手。",
    "Quoted by": "报价：",
    "Quote before repairing this one": "这台机器维修前先报价",
    "Sales are told as soon as the slip is registered.": "服务单一开出，销售就会收到通知。",
    "Quote first": "先报价",
    "Recently looked up": "最近查看",
    // The diesel shortcut on Bulk Order.
    "Order Diesel": "订购柴油",
    "Tap again to send": "再按一次发送",
    "Sending…": "发送中…",
    "Diesel order sent to the purchaser": "柴油订单已发送给采购",
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
    // Shortened when it moved onto the status line beside the camera hint.
    "Restart": "重启",
    "Part number or barcode": "零件编号或条码",
    "e.g. 525IB": "例如：525IB",
    "Parts on this machine": "本机器的零件",
    "Scan or type a part to add it to this machine.": "扫描或输入零件编号，添加到本机器。",
    "No parts yet": "暂无零件",
    "Labour Charge": "人工费",
    "(technician time, on top of parts)": "（技术员工时，另加于零件）",
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
    "View Sales Order": "查看销售订单",
    "Sales Order": "销售订单",
    "Order total": "订单总额",
    "Item Code": "货品编号",
    "Qty": "数量",
    "Price": "单价",
    "Amount": "金额",
    "SubTotal": "小计",
    "No sales order for this slip yet.": "此服务单尚无销售订单。",
    "Machines received:": "收到的机器：",
    "Contact No.": "联络电话",
    "Check & Service for all": "全部检查与保养",
    "Quote first": "先报价",
    "has comment": "有维修说明",

    // ---- Statuses (STATUS_LABEL in app.js) ----
    "Open": "待处理",
    "In Progress": "进行中",
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
  // Own-property check, so a type such as "constructor" cannot find something
  // on Object.prototype and come back as a translation.
  function hasDict(k) {
    return Object.prototype.hasOwnProperty.call(DICT, k);
  }

  var PATTERNS = [
    // Dates, alone and inside the lines that carry them
    [new RegExp("^" + DATE + "$"), function (_, d, m, y) { return cnDate(d, m, y); }],
    [new RegExp("^Created: " + DATE + "$"), function (_, d, m, y) { return "创建日期：" + cnDate(d, m, y); }],
    [new RegExp("^on " + DATE + "$"), function (_, d, m, y) { return "于 " + cnDate(d, m, y); }],
    [new RegExp("^Slip (.+) · Created " + DATE + "$"),
      function (_, s, d, m, y) { return "服务单 " + s + " · 创建于 " + cnDate(d, m, y); }],
    [new RegExp("^(\\d+) machines? · " + DATE + "$"),
      function (_, n, d, m, y) { return n + " 台机器 · " + cnDate(d, m, y); }],

    // ---- IPL ----
    // These carry a machine type inside them, so the type is looked up in DICT
    // rather than spelled out again in a pattern per category. A type that is
    // not in DICT comes back unchanged, which translate() then treats as no
    // translation at all — so an unfamiliar category is left alone rather than
    // half-rendered.
    [/^([A-Za-z][A-Za-z ]*[A-Za-z]) (\d+)$/, function (whole, type, n) {
      return hasDict(type) ? DICT[type] + " " + n : whole;   // filter chips
    }],
    [/^([A-Za-z][A-Za-z ]*[A-Za-z]) · (\d+) figures?$/, function (whole, type, n) {
      return hasDict(type) ? DICT[type] + " · " + n + " 张图" : whole;
    }],
    [/^(\d+) figures? · (\d+) parts?$/, "$1 张图 · $2 个零件"],
    [/^(\d+) figures?$/, "$1 张图"],
    // The part description comes from AutoCount and is left exactly as it is.
    [/^Order (\d+) × (.+)$/, "申请 $1 × $2"],
    [/^(.+) · requested by (.+)$/, "$1 · 申请人：$2"],
    [/^Nothing matches “(.+)”$/, "没有符合“$1”的型号"],

    // Counts and summaries
    [/^(\d+) machines?$/, "$1 台机器"],
    [/^(\d+) parts?$/, "$1 个零件"],
    [/^(\d+) parts? · has comment$/, "$1 个零件 · 有维修说明"],
    [/^(\d+) parts? · has comment · (.+)$/, "$1 个零件 · 有维修说明 · $2"],
    [/^(\d+) parts? · (\$[\d.,]+)$/, "$1 个零件 · $2"],
    [/^(\d+) parts? · (\d+) qty across (\d+) machines?$/, "$1 个零件 · 共 $2 件，分布于 $3 台机器"],
    [/^(\d+) parts? · (\d+) qty across (\d+) machines? · incl\. (.+) labour$/,
      "$1 个零件 · 共 $2 件，分布于 $3 台机器 · 含人工费 $4"],
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

  // Technicians default to Chinese, but the topbar toggle can switch a phone
  // to English ("om_lang" = "en"). The layer installs at page load, so the
  // toggle in app.js flips this key and reloads — same pattern as role changes.
  function wantsEnglish() {
    try { return localStorage.getItem("om_lang") === "en"; } catch (e) { return false; }
  }

  function boot() {
    if (!isTech() || wantsEnglish()) return;
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
