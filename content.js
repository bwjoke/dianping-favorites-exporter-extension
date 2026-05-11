(() => {
  if (window.__dpLocalFavoritesExporterLoaded) {
    return;
  }
  window.__dpLocalFavoritesExporterLoaded = true;

  const EXPORT_HEADERS = [
    "导出批次",
    "来源",
    "采集页面",
    "商户ID",
    "商户名称",
    "商户链接",
    "商户类型",
    "城市",
    "商圈",
    "分类JSON",
    "评分",
    "人均价格",
    "地址",
    "电话",
    "营业时间",
    "标签JSON",
    "推荐菜JSON",
    "特色JSON",
    "详情补充状态",
    "原始摘要"
  ];

  const TYPE_RULES = [
    ["restaurant", ["美食", "餐厅", "火锅", "烧烤", "咖啡", "茶", "面包", "甜品", "小吃", "自助餐", "日本菜", "韩国料理", "西餐", "中餐", "酒吧"]],
    ["hotel", ["酒店", "民宿", "宾馆", "住宿", "客栈", "度假村"]],
    ["attraction", ["景点", "旅游", "公园", "博物馆", "展览", "游乐", "温泉", "度假"]],
    ["spa", ["按摩", "足疗", "养生", "SPA", "采耳", "推拿"]],
    ["beauty", ["美甲", "美容", "美发", "医美", "纹身", "皮肤管理"]],
    ["fitness", ["健身", "运动", "瑜伽", "游泳", "舞蹈", "拳击"]],
    ["entertainment", ["KTV", "密室", "剧本杀", "电影院", "桌游", "棋牌", "电玩", "网吧"]],
    ["shopping", ["购物", "商场", "超市", "便利店", "服饰", "家居", "数码"]],
    ["service", ["维修", "摄影", "亲子", "教育", "培训", "医院", "口腔", "体检", "洗衣"]]
  ];

  const BAD_NAME_RE = /^(首页|下载|登录|注册|收藏|我的收藏|大众点评|美团|更多|全部|下一页|上一页|写点评|商户合作|查看详情|立即查看)$/;
  const BAD_TOKEN_RE = /^(全部|更多|查看|收起|展开|写点评|我要点评|团购|优惠|套餐|评价|评论|图片|地图|导航|电话|地址|营业时间|人均|口味|环境|服务|效果|项目)$/;

  let cancelRequested = false;
  let isRunning = false;
  let overlay;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type === undefined) {
      return false;
    }

    if (message.type === "DP_EXPORT_STOP") {
      cancelRequested = true;
      updateOverlay("正在停止，当前请求结束后会保存已抓取数据...");
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "DP_EXPORT_START") {
      if (isRunning) {
        sendResponse({ ok: false, error: "导出任务已经在运行。" });
        return false;
      }

      isRunning = true;
      cancelRequested = false;
      runExport(normalizeOptions(message.options || {}))
        .catch((error) => {
          updateOverlay(`导出失败：${error instanceof Error ? error.message : String(error)}`, true);
        })
        .finally(() => {
          isRunning = false;
        });
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function runExport(options) {
    const batch = timestampForName();
    const itemsByKey = new Map();

    ensureOverlay();
    updateOverlay("开始读取当前页面收藏商户...");

    await collectVisiblePage(itemsByKey, batch, options);

    if (options.crawlLinkedPages && !cancelRequested) {
      await collectLinkedPages(itemsByKey, batch, options);
    }

    let items = Array.from(itemsByKey.values());
    if (options.maxItems) {
      items = items.slice(0, options.maxItems);
    }

    if (options.includeDetails && !cancelRequested) {
      for (let index = 0; index < items.length; index += 1) {
        if (cancelRequested) {
          break;
        }
        const item = items[index];
        updateOverlay(`补充详情 ${index + 1}/${items.length}：${item["商户名称"] || item["商户ID"] || "商户"}`);
        await enrichItemFromDetail(item);
        await delay(options.delayMs);
      }
    }

    const finalItems = items.map(prepareOutputItem);
    const jsonl = finalItems.map((item) => JSON.stringify(item)).join("\n");
    const csv = toCsv(finalItems);
    const suffix = cancelRequested ? "partial" : "complete";

    downloadText(`dianping-favorites-${batch}-${suffix}.jsonl`, jsonl, "application/x-ndjson;charset=utf-8");
    downloadText(`dianping-favorites-${batch}-${suffix}.csv`, "\uFEFF" + csv, "text/csv;charset=utf-8");

    updateOverlay(`导出完成：${finalItems.length} 个收藏商户，已下载 CSV 和 JSONL。${cancelRequested ? "（已按请求提前停止）" : ""}`, true);
  }

  function normalizeOptions(options) {
    return {
      delayMs: Math.max(500, Number(options.delayMs) || 1200),
      maxScrolls: Math.max(0, Math.trunc(Number(options.maxScrolls) || 0)),
      maxItems: options.maxItems ? Math.max(1, Math.trunc(Number(options.maxItems))) : null,
      maxLinkedPages: Math.max(1, Math.trunc(Number(options.maxLinkedPages) || 100)),
      crawlLinkedPages: options.crawlLinkedPages !== false,
      includeDetails: options.includeDetails !== false
    };
  }

  async function collectVisiblePage(itemsByKey, batch, options) {
    let lastCount = -1;
    let stableRounds = 0;

    for (let round = 0; round <= options.maxScrolls; round += 1) {
      const beforeCount = itemsByKey.size;
      addItems(itemsByKey, parseFavoriteItems(document, location.href, batch));
      const added = itemsByKey.size - beforeCount;
      updateOverlay(`读取当前页面：已收集 ${itemsByKey.size} 个商户${added ? `，本轮新增 ${added} 个` : ""}...`);

      if (cancelRequested || round >= options.maxScrolls || reachedMaxItems(itemsByKey, options)) {
        break;
      }

      const scroller = document.scrollingElement || document.documentElement;
      const beforeHeight = scroller.scrollHeight;
      window.scrollTo({ top: beforeHeight, behavior: "auto" });
      await delay(options.delayMs);

      if (itemsByKey.size === lastCount && scroller.scrollHeight === beforeHeight) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
      }
      if (stableRounds >= 2) {
        break;
      }
      lastCount = itemsByKey.size;
    }
  }

  async function collectLinkedPages(itemsByKey, batch, options) {
    let nextUrl = findNextPageUrl(document, location.href);
    const visited = new Set([stripHash(location.href)]);
    let page = 1;

    while (nextUrl && page < options.maxLinkedPages && !cancelRequested && !reachedMaxItems(itemsByKey, options)) {
      const normalized = stripHash(nextUrl);
      if (visited.has(normalized)) {
        break;
      }
      visited.add(normalized);
      page += 1;
      updateOverlay(`读取下一页 ${page}/${options.maxLinkedPages}，已收集 ${itemsByKey.size} 个商户...`);

      const html = await fetchText(nextUrl);
      assertReadablePage(html, nextUrl);
      const doc = parseHtml(html);
      addItems(itemsByKey, parseFavoriteItems(doc, nextUrl, batch));
      nextUrl = findNextPageUrl(doc, nextUrl);
      await delay(options.delayMs);
    }
  }

  function addItems(itemsByKey, items) {
    for (const item of items) {
      const key = item["商户ID"] || stripQuery(item["商户链接"]) || item["商户名称"];
      if (!key || itemsByKey.has(key)) {
        continue;
      }
      itemsByKey.set(key, item);
    }
  }

  function reachedMaxItems(itemsByKey, options) {
    return Boolean(options.maxItems && itemsByKey.size >= options.maxItems);
  }

  async function fetchText(url) {
    const parsed = new URL(url, location.href);
    if (!isAllowedDianpingUrl(parsed.href)) {
      throw new Error(`跳过非大众点评链接：${safeUrlForMessage(parsed.href)}`);
    }

    if (parsed.hostname === location.hostname) {
      const response = await fetch(parsed.href, {
        credentials: "include",
        redirect: "follow"
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`请求失败：HTTP ${response.status}`);
      }
      return text;
    }

    const response = await chrome.runtime.sendMessage({
      type: "DP_EXPORT_FETCH",
      url: parsed.href
    });
    if (!response || !response.ok) {
      const detail = response && response.error ? response.error : `HTTP ${response && response.status}`;
      throw new Error(`请求失败：${detail}`);
    }
    return response.text || "";
  }

  function assertReadablePage(html, url) {
    const doc = parseHtml(html);
    const text = clean(doc.body ? doc.body.textContent : "");
    const title = clean(doc.title);
    const loginLike = /登录|注册/.test(title) && /账号|密码|验证码|手机号/.test(text);
    const blockedLike = /验证码|安全验证|访问过于频繁|人机验证|滑动验证/.test(text);
    if (loginLike || blockedLike) {
      throw new Error(`页面需要人工处理，请在浏览器中确认后重试：${safeUrlForMessage(url)}`);
    }
  }

  function parseHtml(html) {
    return new DOMParser().parseFromString(html, "text/html");
  }

  function parseFavoriteItems(doc, sourcePage, batch) {
    const anchors = Array.from(doc.querySelectorAll('a[href*="/shop/"], a[href*="shopid="], a[href*="shopId="]'));
    const items = [];
    const seen = new Set();

    for (const anchor of anchors) {
      const url = normalizeUrl(anchor.getAttribute("href"), sourcePage);
      if (!url || !isAllowedDianpingUrl(url) || !isMerchantUrl(url)) {
        continue;
      }

      const card = closestCard(anchor);
      const name = extractName(card, anchor);
      if (!isGoodName(name)) {
        continue;
      }

      const key = extractMerchantId(url) || stripQuery(url) || name;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      const rawText = compactText(card && card.textContent ? card.textContent : anchor.textContent).slice(0, 1200);
      const categories = extractCategories(card, rawText);
      const tags = extractTags(card, rawText);

      items.push({
        "导出批次": batch,
        "来源": "大众点评收藏",
        "采集页面": stripQuery(sourcePage),
        "商户ID": extractMerchantId(url),
        "商户名称": name,
        "商户链接": stripQuery(url),
        "商户类型": classifyBusinessType(categories, rawText),
        "城市": extractCity(doc, sourcePage),
        "商圈": extractArea(card, rawText),
        "分类JSON": categories,
        "评分": extractRating(rawText),
        "人均价格": extractAveragePrice(rawText),
        "地址": extractAddress(card, rawText),
        "电话": "",
        "营业时间": "",
        "标签JSON": tags,
        "推荐菜JSON": [],
        "特色JSON": [],
        "详情补充状态": "未请求",
        "原始摘要": rawText,
        "_detailUrl": stripQuery(url)
      });
    }

    return items;
  }

  async function enrichItemFromDetail(item) {
    const detailUrl = item._detailUrl;
    if (!detailUrl || !isMerchantUrl(detailUrl)) {
      item["详情补充状态"] = "无详情链接";
      return;
    }

    try {
      const html = await fetchText(detailUrl);
      assertReadablePage(html, detailUrl);
      const doc = parseHtml(html);
      const text = compactText(doc.body ? doc.body.textContent : "");

      item["商户名称"] = extractDetailName(doc) || item["商户名称"];
      item["城市"] = item["城市"] || extractCity(doc, detailUrl);
      item["分类JSON"] = mergeUnique(item["分类JSON"], extractDetailCategories(doc, text));
      item["商户类型"] = classifyBusinessType(item["分类JSON"], text);
      item["评分"] = item["评分"] || extractRating(text);
      item["人均价格"] = item["人均价格"] || extractAveragePrice(text);
      item["地址"] = item["地址"] || extractAddress(doc.body || doc, text);
      item["电话"] = extractPhone(text) || item["电话"];
      item["营业时间"] = extractOpeningHours(text) || item["营业时间"];
      item["标签JSON"] = mergeUnique(item["标签JSON"], extractTags(doc.body || doc, text));
      item["推荐菜JSON"] = extractRecommendedDishes(doc, text);
      item["特色JSON"] = extractFeatures(doc, text, item["推荐菜JSON"]);
      item["原始摘要"] = item["原始摘要"] || text.slice(0, 1200);
      item["详情补充状态"] = "成功";
    } catch (error) {
      item["详情补充状态"] = `失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }

  function closestCard(anchor) {
    let best = anchor;
    let node = anchor;
    for (let depth = 0; node && depth < 7; depth += 1) {
      if (node.nodeType !== Node.ELEMENT_NODE) {
        node = node.parentElement;
        continue;
      }
      const text = clean(node.textContent);
      const shopLinks = node.querySelectorAll ? node.querySelectorAll('a[href*="/shop/"], a[href*="shopid="], a[href*="shopId="]').length : 0;
      if (text.length >= 8 && text.length <= 1600 && shopLinks <= 6) {
        best = node;
      }
      node = node.parentElement;
    }
    return best;
  }

  function extractName(card, anchor) {
    const candidates = [
      anchor.getAttribute("title"),
      anchor.getAttribute("aria-label"),
      anchor.querySelector("img") && anchor.querySelector("img").getAttribute("alt"),
      anchor.textContent
    ];

    if (card && card.querySelectorAll) {
      const nameSelectors = [
        "h1",
        "h2",
        "h3",
        "h4",
        ".title",
        ".name",
        ".shop-name",
        ".shopName",
        '[class*="title"]',
        '[class*="Title"]',
        '[class*="name"]',
        '[class*="Name"]'
      ];
      for (const selector of nameSelectors) {
        const node = card.querySelector(selector);
        if (node) {
          candidates.push(node.textContent);
        }
      }
    }

    for (const candidate of candidates) {
      const name = clean(candidate).replace(/^收藏\s*/, "").replace(/\s*-\s*大众点评.*$/, "");
      if (isGoodName(name)) {
        return name.slice(0, 80);
      }
    }
    return "";
  }

  function extractDetailName(doc) {
    const selectors = [
      "h1",
      ".shop-name",
      ".shopName",
      '[class*="shopName"]',
      '[class*="ShopName"]',
      '[class*="title"]',
      '[class*="Title"]'
    ];
    for (const selector of selectors) {
      const text = clean(textOf(doc, selector));
      if (isGoodName(text)) {
        return text.slice(0, 80);
      }
    }
    return "";
  }

  function isGoodName(value) {
    const text = clean(value);
    return Boolean(text && text.length >= 2 && text.length <= 80 && !BAD_NAME_RE.test(text) && !/^\d+(\.\d+)?$/.test(text));
  }

  function extractMerchantId(url) {
    try {
      const parsed = new URL(url, location.href);
      const direct = parsed.pathname.match(/\/shop\/([^/?#]+)/i);
      if (direct && direct[1]) {
        return decodeURIComponent(direct[1]);
      }
      return parsed.searchParams.get("shopid") || parsed.searchParams.get("shopId") || "";
    } catch (_error) {
      return "";
    }
  }

  function isMerchantUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return /\/shop\/[^/?#]+/i.test(parsed.pathname) || parsed.searchParams.has("shopid") || parsed.searchParams.has("shopId");
    } catch (_error) {
      return false;
    }
  }

  function extractCategories(root, rawText) {
    const values = [];
    if (root && root.querySelectorAll) {
      const nodes = root.querySelectorAll([
        ".tag",
        ".tags",
        ".category",
        ".cate",
        'a[href*="/search/category"]',
        'a[href*="/search/keyword"]',
        '[class*="tag"]',
        '[class*="Tag"]',
        '[class*="cate"]',
        '[class*="Cate"]',
        '[class*="category"]',
        '[class*="Category"]'
      ].join(","));
      for (const node of nodes) {
        const token = clean(node.textContent);
        if (isGoodToken(token)) {
          values.push(token);
        }
      }
    }

    const known = [
      "美食", "火锅", "烧烤", "咖啡", "茶馆", "甜品", "小吃", "自助餐", "日本菜", "韩国料理", "西餐", "中餐",
      "酒店", "民宿", "景点", "旅游", "休闲娱乐", "KTV", "密室", "剧本杀", "电影院", "按摩", "足疗", "养生",
      "美甲", "美容", "美发", "健身", "瑜伽", "购物", "商场", "亲子", "教育", "医疗健康", "摄影"
    ];
    for (const word of known) {
      if (rawText.includes(word)) {
        values.push(word);
      }
    }

    return mergeUnique([], values).slice(0, 12);
  }

  function extractDetailCategories(doc, text) {
    const values = extractCategories(doc.body || doc, text);
    const breadcrumbNodes = doc.querySelectorAll(".breadcrumb a, .crumb a, [class*='breadcrumb'] a, [class*='crumb'] a");
    for (const node of breadcrumbNodes) {
      const token = clean(node.textContent);
      if (isGoodToken(token)) {
        values.push(token);
      }
    }
    return mergeUnique([], values).slice(0, 16);
  }

  function extractTags(root, rawText) {
    const values = [];
    if (root && root.querySelectorAll) {
      const nodes = root.querySelectorAll(".tag, .tags span, .comment-list span, [class*='tag'], [class*='Tag'], [class*='label'], [class*='Label']");
      for (const node of nodes) {
        const token = clean(node.textContent);
        if (isGoodToken(token)) {
          values.push(token);
        }
      }
    }

    const phraseMatches = rawText.match(/(环境好|服务好|性价比高|味道好|位置好找|停车方便|适合聚餐|适合约会|适合亲子|回头客|老字号|网红店|排队|安静|干净|交通便利)/g) || [];
    values.push(...phraseMatches);
    return mergeUnique([], values).slice(0, 20);
  }

  function extractFeatures(doc, text, recommendedDishes) {
    const values = [];
    const featureMatches = text.match(/(免费停车|可预约|可外带|可堂食|包间|露台|景观位|亲子友好|无烟区|营业中|可刷卡|有团购|有套餐)/g) || [];
    values.push(...featureMatches);

    if (Array.isArray(recommendedDishes) && recommendedDishes.length > 0) {
      values.push("有推荐菜");
    }

    if (doc && doc.querySelectorAll) {
      const nodes = doc.querySelectorAll("[class*='feature'], [class*='Feature'], [class*='facility'], [class*='Facility']");
      for (const node of nodes) {
        const token = clean(node.textContent);
        if (isGoodToken(token)) {
          values.push(token);
        }
      }
    }

    return mergeUnique([], values).slice(0, 20);
  }

  function extractRecommendedDishes(doc, text) {
    const values = [];
    const selector = [
      'a[href*="dish"]',
      '[class*="dish"]',
      '[class*="Dish"]',
      '[class*="recommend"]',
      '[class*="Recommend"]',
      '[class*="menu"]',
      '[class*="Menu"]'
    ].join(",");

    for (const node of doc.querySelectorAll(selector)) {
      const token = clean(node.textContent);
      if (isDishToken(token)) {
        values.push(token);
      }
    }

    for (const node of doc.querySelectorAll("h2,h3,h4,div,section,dl")) {
      const label = clean(node.textContent);
      if (!/推荐菜|招牌菜|必点/.test(label) || label.length > 40) {
        continue;
      }
      const scope = node.parentElement || node;
      const candidates = scope.querySelectorAll("a,span,li,em,strong");
      for (const candidate of candidates) {
        const token = clean(candidate.textContent);
        if (isDishToken(token)) {
          values.push(token);
        }
      }
    }

    const section = text.match(/(?:推荐菜|招牌菜|必点)[:：]?\s*([^。；;]{0,240})/);
    if (section && section[1]) {
      const chunks = section[1].split(/[、,，/｜| ]+/);
      for (const chunk of chunks) {
        if (isDishToken(chunk)) {
          values.push(clean(chunk));
        }
      }
    }

    return mergeUnique([], values).slice(0, 30);
  }

  function isDishToken(value) {
    const text = clean(value);
    return Boolean(
      text &&
      text.length >= 2 &&
      text.length <= 24 &&
      !BAD_TOKEN_RE.test(text) &&
      !/推荐菜|招牌菜|必点|全部|更多|查看|上传|点评|评价|人均|营业|地址|电话|收藏|团购|套餐|优惠|￥|¥|\d+人|\d+分/.test(text)
    );
  }

  function isGoodToken(value) {
    const text = clean(value);
    return Boolean(text && text.length >= 2 && text.length <= 28 && !BAD_TOKEN_RE.test(text) && !/^\d+(\.\d+)?$/.test(text));
  }

  function classifyBusinessType(categories, rawText) {
    const haystack = `${Array.isArray(categories) ? categories.join(" ") : ""} ${rawText || ""}`.toUpperCase();
    for (const [type, keywords] of TYPE_RULES) {
      if (keywords.some((keyword) => haystack.includes(keyword.toUpperCase()))) {
        return type;
      }
    }
    return "other";
  }

  function extractRating(text) {
    const value = valueByPatterns(text, [
      /(?:评分|综合评分|商户评分|总分)[:：]?\s*(\d(?:\.\d)?)/,
      /(\d(?:\.\d)?)\s*分/
    ]);
    return value || "";
  }

  function extractAveragePrice(text) {
    return valueByPatterns(text, [
      /(?:人均|均价|参考价|消费)[:：\s]*(?:¥|￥)?\s*(\d+(?:\.\d+)?)/,
      /(?:¥|￥)\s*(\d+(?:\.\d+)?)\s*\/?\s*人/
    ]);
  }

  function extractArea(root, rawText) {
    const text = clean(rawText);
    const known = valueByPatterns(text, [
      /(?:商圈|区域)[:：]\s*([^\s,，/｜|]{2,16})/
    ]);
    if (known) {
      return known;
    }

    if (root && root.querySelectorAll) {
      const nodes = root.querySelectorAll('a[href*="/search/keyword"], a[href*="/search/category"], [class*="region"], [class*="area"], [class*="Area"]');
      for (const node of nodes) {
        const token = clean(node.textContent);
        if (isGoodToken(token) && !TYPE_RULES.some(([, words]) => words.includes(token))) {
          return token;
        }
      }
    }
    return "";
  }

  function extractAddress(root, rawText) {
    if (root && root.querySelector) {
      const selectors = [
        "#address",
        ".address",
        ".addr",
        ".shop-addr",
        '[class*="address"]',
        '[class*="Address"]',
        '[class*="addr"]',
        '[class*="Addr"]'
      ];
      for (const selector of selectors) {
        const value = clean(textOf(root, selector));
        if (looksLikeAddress(value)) {
          return value.slice(0, 120);
        }
      }
    }

    const address = valueByPatterns(rawText, [
      /地址[:：]?\s*([^电话营业推荐评价]{4,120})/,
      /(?:位于|位於)\s*([^电话营业推荐评价]{4,120})/
    ]);
    return looksLikeAddress(address) ? address.slice(0, 120) : "";
  }

  function looksLikeAddress(value) {
    const text = clean(value);
    return Boolean(text && text.length >= 4 && /路|街|号|弄|巷|层|楼|区|县|市|广场|中心|大厦|商场|园/.test(text));
  }

  function extractPhone(text) {
    return valueByPatterns(text, [
      /电话[:：]\s*([0-9+\-()（）\s]{7,30})/,
      /商户电话[:：]\s*([0-9+\-()（）\s]{7,30})/
    ]);
  }

  function extractOpeningHours(text) {
    return valueByPatterns(text, [
      /营业时间[:：]\s*([^地址电话推荐评价]{4,80})/,
      /营业中[:：]?\s*([^地址电话推荐评价]{4,80})/
    ]);
  }

  function extractCity(doc, pageUrl) {
    try {
      const parsed = new URL(pageUrl, location.href);
      const fromPath = parsed.pathname.match(/^\/([^/]+)\//);
      if (fromPath && fromPath[1] && !/shop|member|user|search|review|photos/i.test(fromPath[1])) {
        return decodeURIComponent(fromPath[1]);
      }
    } catch (_error) {
      // Ignore URL parsing fallback.
    }

    const title = clean(doc.title);
    const titleMatch = title.match(/(.{2,10})(?:美食|酒店|旅游|购物|休闲娱乐|大众点评)/);
    return titleMatch ? titleMatch[1].replace(/_$/, "") : "";
  }

  function findNextPageUrl(doc, baseUrl) {
    const candidates = Array.from(doc.querySelectorAll('a[rel="next"], a.next, a[class*="next"], a[href]'));
    for (const anchor of candidates) {
      const text = clean(anchor.textContent || anchor.getAttribute("aria-label") || anchor.getAttribute("title"));
      const className = String(anchor.className || "");
      if (!/(下一页|下页|Next|›|>)/i.test(text) && !/next/i.test(className)) {
        continue;
      }
      if (/disabled|disable/i.test(className) || anchor.getAttribute("aria-disabled") === "true") {
        continue;
      }
      const href = anchor.getAttribute("href");
      if (!href || /^javascript:/i.test(href) || href === "#") {
        continue;
      }
      const url = normalizeUrl(href, baseUrl);
      if (url && isAllowedDianpingUrl(url)) {
        return url;
      }
    }
    return "";
  }

  function valueByPatterns(text, patterns) {
    for (const pattern of patterns) {
      const match = String(text || "").match(pattern);
      if (match && match[1]) {
        return clean(match[1]);
      }
    }
    return "";
  }

  function textOf(root, selector) {
    const node = root && root.querySelector ? root.querySelector(selector) : null;
    return node ? node.textContent || "" : "";
  }

  function clean(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function compactText(value) {
    return clean(value).replace(/\s*([：:])\s*/g, "$1");
  }

  function mergeUnique(base, extra) {
    const seen = new Set();
    const merged = [];
    for (const value of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
      const text = clean(value);
      if (!text || seen.has(text)) {
        continue;
      }
      seen.add(text);
      merged.push(text);
    }
    return merged;
  }

  function normalizeUrl(href, baseUrl = location.href) {
    if (!href) {
      return "";
    }
    try {
      return new URL(href, baseUrl).href;
    } catch (_error) {
      return "";
    }
  }

  function isAllowedDianpingUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.protocol === "https:" && (
        parsed.hostname === "dianping.com" ||
        parsed.hostname.endsWith(".dianping.com")
      );
    } catch (_error) {
      return false;
    }
  }

  function stripQuery(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.origin}${parsed.pathname}`;
    } catch (_error) {
      return url;
    }
  }

  function stripHash(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.hash = "";
      return parsed.href;
    } catch (_error) {
      return url;
    }
  }

  function safeUrlForMessage(url) {
    try {
      const parsed = new URL(url, location.href);
      return `${parsed.hostname}${parsed.pathname}`;
    } catch (_error) {
      return "当前页面";
    }
  }

  function prepareOutputItem(item) {
    const copy = { ...item };
    delete copy._detailUrl;
    return copy;
  }

  function toCsv(items) {
    const rows = [EXPORT_HEADERS];
    for (const item of items) {
      rows.push(EXPORT_HEADERS.map((header) => item[header] ?? ""));
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
  }

  function csvCell(value) {
    const rawText = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "");
    const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  }

  function downloadText(fileName, text, mimeType) {
    const blob = new Blob([text], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function timestampForName() {
    const now = new Date();
    const pad = (number) => String(number).padStart(2, "0");
    return [
      now.getFullYear(),
      pad(now.getMonth() + 1),
      pad(now.getDate()),
      "-",
      pad(now.getHours()),
      pad(now.getMinutes()),
      pad(now.getSeconds())
    ].join("");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function ensureOverlay() {
    if (overlay && document.body.contains(overlay)) {
      return;
    }
    overlay = document.createElement("div");
    overlay.id = "dp-local-exporter-overlay";
    overlay.style.cssText = [
      "position:fixed",
      "right:16px",
      "bottom:16px",
      "z-index:2147483647",
      "width:320px",
      "padding:12px",
      "border:1px solid #d9e2ec",
      "border-radius:8px",
      "box-shadow:0 12px 32px rgba(15,23,42,.18)",
      "background:#fff",
      "color:#102a43",
      "font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif"
    ].join(";");
    document.body.appendChild(overlay);
  }

  function updateOverlay(message, done = false) {
    ensureOverlay();
    overlay.textContent = message;
    if (done) {
      const closeButton = document.createElement("button");
      closeButton.textContent = "关闭";
      closeButton.style.cssText = "display:block;margin-top:8px;padding:4px 10px;border:0;border-radius:5px;background:#52606d;color:#fff;cursor:pointer";
      closeButton.addEventListener("click", () => overlay.remove());
      overlay.appendChild(closeButton);
    }
  }
})();
