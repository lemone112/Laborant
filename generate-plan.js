const fs = require("fs");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  PageBreak, Header, Footer, PageNumber, NumberFormat,
  AlignmentType, HeadingLevel, WidthType, BorderStyle, ShadingType,
  PageOrientation, TableOfContents, LevelFormat, SectionType,
} = require("docx");

// ── Palette: DM-1 Deep Cyan (Tech / AI) ──
const P = {
  primary: "162235",
  body: "1A2B40",
  secondary: "6878A0",
  accent: "5B8DB8",
  surface: "F4F8FC",
  bg: "162235",
  cover: { titleColor: "FFFFFF", subtitleColor: "B0B8C0", metaColor: "90989F", footerColor: "687078" },
  table: { headerBg: "1B6B7A", headerText: "FFFFFF", accentLine: "1B6B7A", innerLine: "C8DDE2", surface: "EDF3F5" },
};
const c = (hex) => hex.replace("#","");

const NB = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const noBorders = { top: NB, bottom: NB, left: NB, right: NB };
const allNoBorders = { top: NB, bottom: NB, left: NB, right: NB, insideHorizontal: NB, insideVertical: NB };

// ── Helpers ──
function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160, line: 312 },
    children: [new TextRun({ text, bold: true, size: 32, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120, line: 312 },
    children: [new TextRun({ text, bold: true, size: 28, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 100, line: 312 },
    children: [new TextRun({ text, bold: true, size: 26, color: c(P.primary), font: { ascii: "Calibri", eastAsia: "SimHei" } })],
  });
}
function para(text, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.JUSTIFIED,
    indent: opts.noIndent ? undefined : { firstLine: 420 },
    spacing: { line: 312, after: opts.after || 80 },
    children: [new TextRun({ text, size: opts.size || 24, color: c(opts.color || P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, bold: opts.bold || false })],
  });
}
function paraRuns(runs, opts = {}) {
  return new Paragraph({
    alignment: opts.align || AlignmentType.JUSTIFIED,
    indent: opts.noIndent ? undefined : { firstLine: 420 },
    spacing: { line: 312, after: opts.after || 80 },
    children: runs.map(r => new TextRun({ size: 24, color: c(P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, ...r })),
  });
}
function bullet(text, level = 0) {
  return new Paragraph({
    bullet: { level },
    spacing: { line: 312, after: 40 },
    children: [new TextRun({ text, size: 24, color: c(P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } })],
  });
}
function code(text) {
  return new Paragraph({
    alignment: AlignmentType.LEFT,
    indent: { left: 480 },
    spacing: { line: 280, after: 40 },
    shading: { type: ShadingType.CLEAR, fill: "F0F4F8" },
    children: [new TextRun({ text, size: 20, color: "2D3748", font: { ascii: "Consolas", eastAsia: "Consolas" } })],
  });
}
function codeBlock(lines) {
  return lines.map(l => code(l));
}

// ── Table builder ──
function makeTable(headers, rows) {
  const t = P.table;
  const hdrCell = (text) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text, bold: true, size: 21, color: t.headerText, font: { ascii: "Calibri", eastAsia: "SimHei" } })] })],
    shading: { type: ShadingType.CLEAR, fill: t.headerBg },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
  });
  const dataCell = (text, idx) => new TableCell({
    children: [new Paragraph({ children: [new TextRun({ text: String(text), size: 21, color: c(P.body), font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" } })] })],
    shading: idx % 2 === 0 ? { type: ShadingType.CLEAR, fill: t.surface } : { type: ShadingType.CLEAR, fill: "FFFFFF" },
    margins: { top: 60, bottom: 60, left: 120, right: 120 },
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: t.accentLine },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: t.accentLine },
      left: { style: BorderStyle.NONE },
      right: { style: BorderStyle.NONE },
      insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: t.innerLine },
      insideVertical: { style: BorderStyle.NONE },
    },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: headers.map(hdrCell) }),
      ...rows.map((row, idx) => new TableRow({ cantSplit: true, children: row.map(cell => dataCell(cell, idx)) })),
    ],
  });
}

// ── Cover R4 ──
function buildCoverR4(config) {
  const PC = config.palette;
  const padL = 1200, padR = 800;
  const availableWidth = 11906 - padL - padR;

  // calcTitleLayout equivalent — simplified
  const title = config.title;
  const titlePt = title.length > 30 ? 28 : title.length > 20 ? 32 : 36;
  const titleSize = titlePt * 2;
  const maxCpl = Math.floor(availableWidth / (titlePt * 20));
  const titleLines = [];
  let rem = title;
  while (rem.length > 0) {
    if (rem.length <= maxCpl) { titleLines.push(rem); break; }
    let bp = maxCpl;
    for (let i = maxCpl; i >= Math.floor(maxCpl * 0.6); i--) {
      if (' \u2013\u2014-_\u30fb\u00b7/'.includes(rem[i-1])) { bp = i; break; }
    }
    titleLines.push(rem.slice(0, bp).trim());
    rem = rem.slice(bp).trim();
  }
  if (titleLines.length > 1 && titleLines[titleLines.length-1].length <= 2) {
    const last = titleLines.pop();
    titleLines[titleLines.length-1] += last;
  }

  const UPPER_H = 7500;
  const DIVIDER_H = 60;
  const topSpacing = Math.max(UPPER_H - titleLines.length * (titlePt * 23 + 200) - 800, 400);

  const upperBlock = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: UPPER_H, rule: "exact" },
      children: [new TableCell({
        shading: { fill: PC.bg }, borders: noBorders,
        verticalAlign: "top",
        margins: { left: padL, right: padR },
        children: [
          new Paragraph({ spacing: { before: topSpacing } }),
          config.englishLabel ? new Paragraph({
            spacing: { after: 500 },
            children: [new TextRun({ text: config.englishLabel.split("").join(" "), size: 18, color: PC.accent, font: { ascii: "Calibri" }, characterSpacing: 60 })],
          }) : null,
          ...titleLines.map((line, i) => new Paragraph({
            spacing: { line: Math.ceil(titlePt * 23), lineRule: "atLeast", after: i < titleLines.length - 1 ? 100 : 200 },
            children: [new TextRun({ text: line, size: titleSize, bold: true, color: PC.cover.titleColor, font: { eastAsia: "SimHei", ascii: "Arial" } })],
          })),
          config.subtitle ? new Paragraph({
            spacing: { after: 100 },
            children: [new TextRun({ text: config.subtitle, size: 24, color: PC.cover.subtitleColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
          }) : null,
        ].filter(Boolean),
      })],
    })],
  });

  const divider = new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: DIVIDER_H, rule: "exact" },
      children: [new TableCell({ borders: noBorders, shading: { fill: PC.accent }, children: [new Paragraph({ children: [] })] })],
    })],
  });

  const lowerContent = [
    new Paragraph({ spacing: { before: 800 } }),
    ...(config.metaLines || []).map(line => new Paragraph({
      indent: { left: padL }, spacing: { after: 100 },
      children: [new TextRun({ text: line, size: 28, color: PC.cover.metaColor, font: { eastAsia: "Microsoft YaHei", ascii: "Arial" } })],
    })),
    new Paragraph({ spacing: { before: 2000 } }),
    new Paragraph({
      indent: { left: padL },
      children: [
        new TextRun({ text: config.footerLeft || "", size: 22, color: "909090" }),
        new TextRun({ text: "          " }),
        new TextRun({ text: config.footerRight || "", size: 22, color: "909090" }),
      ],
    }),
  ];

  return [new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: allNoBorders,
    rows: [new TableRow({
      height: { value: 16838, rule: "exact" },
      children: [new TableCell({
        shading: { fill: "FFFFFF" }, borders: noBorders,
        verticalAlign: "top",
        children: [upperBlock, divider, ...lowerContent],
      })],
    })],
  })];
}

// ══════════════════════════════════════════════════
// ── DOCUMENT CONTENT ──
// ══════════════════════════════════════════════════

const pgSize = { width: 11906, height: 16838, orientation: PageOrientation.PORTRAIT };
const pgMargin = { top: 1440, bottom: 1440, left: 1701, right: 1417 };

// ── Cover section ──
const coverSection = {
  properties: { page: { size: pgSize, margin: { top: 0, bottom: 0, left: 0, right: 0 } } },
  children: buildCoverR4({
    palette: P,
    title: "AI Code Review Pipeline",
    subtitle: "Архитектура, план реализации, деплой",
    englishLabel: "ARCHITECTURE AND IMPLEMENTATION PLAN",
    metaLines: ["Temporal + LangGraph + tree-sitter", "Production-ready GitLab MR Reviewer + MCP Server", "Май 2026"],
    footerLeft: "v1.0",
    footerRight: "2026",
  }),
};

// ── TOC section ──
const tocSection = {
  properties: {
    type: SectionType.NEXT_PAGE,
    page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.UPPER_ROMAN } },
  },
  footers: {
    default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080" })] })] }),
  },
  children: [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 480, after: 360 }, children: [new TextRun({ text: "\u0421\u043e\u0434\u0435\u0440\u0436\u0430\u043d\u0438\u0435", bold: true, size: 32, font: { eastAsia: "SimHei", ascii: "Times New Roman" } })] }),
    new TableOfContents("TOC", { hyperlink: true, headingStyleRange: "1-3" }),
    new Paragraph({ spacing: { before: 200 }, children: [new TextRun({ text: "Note: Right-click TOC \u2192 \"Update Field\" to refresh page numbers.", italics: true, size: 18, color: "888888" })] }),
    new Paragraph({ children: [new PageBreak()] }),
  ],
};

// ── Body ──
const body = [];

// ══════════════════════════════════════
// 1. КРИТИКА И НЕЗАВИСИМОЕ МНЕНИЕ
// ══════════════════════════════════════
body.push(h1("1. Независимый анализ текущего пайплайна"));
body.push(h2("1.1. Что в текущем пайплайне работает хорошо"));
body.push(para("Текущий пайплайн уже содержит четыре ключевых слоя, которые соответствуют уровню production-систем. Landscape Scan формирует сжатое представление кодовой базы, Risk Map выполняет трассировку зависимостей, Triple Review обеспечивает независимый мульти-перспективный анализ, а CoVe реализует верификационный слой с опорой на доказательства. Это не прототип \u2014 это работающая система с продуманной архитектурой рассуждений."));
body.push(para("Особо стоит выделить паттерн Triple Review: три независимых перспективы (логика, риски, консистентность) с разделением ответственности \u2014 это подход уровня ensemble reasoning, который используют зрелые системы вроде CodeRabbit и Amazon CodeGuru. CoVe с его refutation bias и evidence-first подходом является самым сильным местом пайплайна и превосходит большинство AI code review инструментов, которые выполняют только single-pass анализ."));

body.push(h2("1.2. С чем в ревью ИИ я согласен"));
body.push(para("Ревьюер прав в фундаментальном диагнозе: текущий подход \u2014 \u00abLLM-first\u00bb, а нужен \u00abcode-first\u00bb. Это не просто модная концепция, а архитектурная проблема масштабируемости. Каждый merge request заставляет пайплайн платить O(n) за реконструкцию того, что можно вычислить один раз и переиспользовать. Landscape Scan по сути является \u00abmanual RAG summary layer\u00bb \u2014 он работает, но хрупок и дорог."));
body.push(para("Второе верное наблюдение: Symbol Graph критичнее embeddings. tree-sitter \u2192 AST \u2192 call graph \u2014 это детерминистическая операция, которая не галлюцинирует и заменяет 80% того, что Risk Map делает через FILE_REQUEST loops. Это приоритет номер один для Layer 0."));

body.push(h2("1.3. С чем в ревью ИИ я не согласен"));
body.push(h3("1.3.1. \u00abУбери 3 модели, добавь векторизацию\u00bb \u2014 ложная дихотомия"));
body.push(para("Тройной обзор \u2014 это не компенсация отсутствия графа. Это ортогональная вещь. Даже с идеальным symbol graph ты всё ещё хочешь три перспективы на один и тот же дифф: логическую корректность, риск зависимостей и архитектурную консистентность. CodeRabbit тоже использует ensemble approaches, просто не так явно. Проблема не в том, что три модели \u2014 а в том, что три модели делают работу, которую должен делать код (трассировка зависимостей, поиск паттернов)."));

body.push(h3("1.3.2. CoVe переоценён в текущей форме"));
body.push(para("CoVe силён концептуально, но дорогой (3 вызова на каждый ESCALATE finding) и хрупкий. Verifier получает только вопросы + код без контекста оригинального finding, что означает: вопросы должны быть идеально сформулированы, иначе verifier не знает, что именно проверяет. Это не \u00abverification\u00bb \u2014 это \u00abindependent assessment через proxy\u00bb. В продакшене CoVe нужно ограничить бюджетом и сделать опциональным для contested findings с высоким confidence."));

body.push(h3("1.3.3. Векторизация \u2014 не первый приоритет"));
body.push(para("Для code review векторизация полезна для запросов вроде \u00abнайди похожие паттерны\u00bb, но это фича уровня v2. Symbol graph + AST indexing дадут 80% бенефита за 20% усилий. Embeddings добавляются позже, когда будет ясно, какие именно запросы к векторной БД реально нужны пайплайну."));

body.push(h2("1.4. Чего ревью ИИ не заметил"));
body.push(para("Первое: нет фидбек-лупа. Система не учится на human reviews. Если разработчик отклоняет finding \u2014 это сигнал, который нигде не учитывается. Второе: Landscape Scan нужно не \u00abпересчитывать с кешем\u00bb, а поддерживать инкрементально при пуше в дефолтную ветку. Третье: MCP-интеграция требует другого дизайна \u2014 агент может запросить ревью в середине своей работы, значит пайплайн должен принимать partial context. Четвёртое: Report шаг перегружен \u2014 он одновременно форматирует JSON, пишет по-русски, применяет психологические правила, маппит severity. Пятое: нет rate limiting / budget control \u2014 при 5 escalated findings = 21+ LLM вызовов на один MR."));

// ══════════════════════════════════════
// 2. АРХИТЕКТУРА
// ══════════════════════════════════════
body.push(h1("2. Целевая архитектура"));
body.push(h2("2.1. Принцип: Code-first, LLM-smart"));
body.push(para("Фундаментальный сдвиг: от \u00abLLM восстанавливает структуру кода каждый раз\u00bb к \u00abструктура кода уже построена \u2192 LLM только reasoning engine\u00bb. Это не означает упрощение reasoning \u2014 это означает, что reasoning получает детерминистический контекст вместо галлюцинирующего. Структура вычисляется один раз при пуше в дефолтную ветку, а при поступлении MR пайплайн получает уже готовый symbol graph, embeddings и dependency map."));

body.push(h2("2.2. Обзор слоёв"));

body.push(makeTable(
  ["\u0421\u043b\u043e\u0439", "\u041d\u0430\u0437\u043d\u0430\u0447\u0435\u043d\u0438\u0435", "\u0418\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442", "\u041e\u0431\u043d\u043e\u0432\u043b\u0435\u043d\u0438\u0435"],
  [
    ["Layer 0: Repo Intelligence", "AST, symbol graph, embeddings", "tree-sitter + Qdrant + Neo4j", "На каждый push в main"],
    ["Layer 1: Context Assembly", "Сбор контекста для MR", "Temporal workflow", "На каждый MR"],
    ["Layer 2: Reasoning", "Triple Review + Consensus", "LangGraph", "На каждый MR"],
    ["Layer 3: Verification", "CoVe (опционально)", "LangGraph subgraph", "Только для ESCALATE"],
    ["Layer 4: Reporting", "GitLab JSON + summary", "Single LLM call", "На каждый MR"],
    ["Layer 5: Feedback Loop", "Учёт human reviews", "PostgreSQL", "На каждый resolved discussion"],
  ]
));

body.push(h2("2.3. Модель конфигурации через ENV"));
body.push(para("Все настройки моделей вынесены в переменные окружения. Нет хардкода алиасов, URL или ключей. Система определяет четыре уровня моделей: Cheap (для простых операций вроде question generation), Base (для стандартных review задач), Frontier (для сложных reasoning задач вроде CoVe verdict и consensus), Embedding (для векторизации). Base URL \u2014 внутренний IP, что типично для self-hosted инфраструктуры с OpenAI-совместимым API."));

body.push(para("Структура ENV-переменных:", { bold: true, noIndent: true }));
body.push(...codeBlock([
  "# ── LLM Gateway ──",
  "LLM_BASE_URL=http://10.0.0.5:8080/v1",
  "LLM_API_KEY=sk-internal-xxx",
  "",
  "# ── Model Tiers ──",
  "LLM_CHEAP_MODEL=gpt-4o-mini",
  "LLM_BASE_MODEL=gpt-4o",
  "LLM_FRONTIER_MODEL=o3",
  "LLM_EMBEDDING_MODEL=text-embedding-3-small",
  "",
  "# ── Tier Limits ──",
  "LLM_CHEAP_MAX_TOKENS=2048",
  "LLM_BASE_MAX_TOKENS=4096",
  "LLM_FRONTIER_MAX_TOKENS=8192",
  "LLM_EMBEDDING_DIM=1536",
  "",
  "# ── Pipeline Budget ──",
  "PIPELINE_MAX_LLM_CALLS=25",
  "PIPELINE_MAX_COST_USD=0.50",
  "PIPELINE_COVE_ENABLED=true",
  "PIPELINE_COVE_MAX_FINDINGS=5",
  "",
  "# ── Repo Intelligence ──",
  "QDRANT_URL=http://10.0.0.5:6333",
  "NEO4J_URL=bolt://10.0.0.5:7687",
  "NEO4J_USER=neo4j",
  "NEO4J_PASSWORD=xxx",
  "",
  "# ── GitLab ──",
  "GITLAB_URL=https://gitlab.company.com",
  "GITLAB_TOKEN=glpat-xxx",
  "",
  "# ── Temporal ──",
  "TEMPORAL_URL=10.0.0.5:7233",
  "TEMPORAL_NAMESPACE=default",
  "",
  "# ── MCP Server ──",
  "MCP_PORT=3001",
  "MCP_TRANSPORT=stdio",
]));

body.push(para("Код использует модельный уровень, а не конкретную модель. Это позволяет менять провайдера без изменения логики:", { after: 120 }));
body.push(...codeBlock([
  "// src/llm/tiers.ts",
  "export const LLM_TIERS = {",
  "  cheap:     { model: process.env.LLM_CHEAP_MODEL!,     maxTokens: +process.env.LLM_CHEAP_MAX_TOKENS! },",
  "  base:      { model: process.env.LLM_BASE_MODEL!,      maxTokens: +process.env.LLM_BASE_MAX_TOKENS! },",
  "  frontier:  { model: process.env.LLM_FRONTIER_MODEL!,  maxTokens: +process.env.LLM_FRONTIER_MAX_TOKENS! },",
  "  embedding: { model: process.env.LLM_EMBEDDING_MODEL!, dim: +process.env.LLM_EMBEDDING_DIM! },",
  "} as const;",
  "",
  "export const LLM_CONFIG = {",
  "  baseURL: process.env.LLM_BASE_URL!,",
  "  apiKey: process.env.LLM_API_KEY!,",
  "};",
  "",
  "// Маппинг шагов пайплайна на уровни моделей",
  "export const PIPELINE_MODEL_MAP = {",
  "  landscapeScan:     'cheap',    // структурированный вывод, простая задача",
  "  riskMap:           'base',     // нужна логика трассировки",
  "  reviewLogic:       'frontier', // сложный reasoning",
  "  reviewRisk:        'frontier', // сложный reasoning",
  "  reviewConsistency: 'base',     // паттерн-матчинг, менее требовательный",
  "  consensus:         'frontier', // критичный шаг агрегации",
  "  coveQuestionGen:   'cheap',    // генерация вопросов",
  "  coveVerifier:      'base',     // независимая проверка",
  "  coveVerdict:       'frontier', // финальный вердикт",
  "  report:            'base',     // форматирование + русский язык",
  "} as const;",
]));

body.push(h2("2.4. Temporal + LangGraph: разделение ответственности"));
body.push(para("Temporal отвечает за оркестрацию: управление workflow, retry logic, timeout, signal/query, scheduling. LangGraph отвечает за reasoning внутри шагов: состояние, переходы между под-шагами, conditional edges. Это не конкурирующие инструменты \u2014 они дополняют друг друга. Temporal workflow вызывает LangGraph как activity, LangGraph внутри управляет LLM-вызовами и состоянием reasoning."));

body.push(makeTable(
  ["\u0410\u0441\u043f\u0435\u043a\u0442", "Temporal", "LangGraph"],
  [
    ["Оркестрация", "Да \u2014 workflow, signals, queries", "Нет"],
    ["Состояние workflow", "Да \u2014 persistence, replay", "Только внутри graph"],
    ["LLM calls", "Через activities", "Нативно \u2014 nodes, edges"],
    ["Retry / timeout", "Да \u2014 built-in", "Ручная реализация"],
    ["Conditional branching", "Через code", "Через conditional edges"],
    ["Human-in-the-loop", "Signals", "Interrupt + resume"],
    ["Визуализация", "Web UI", "Graph diagram"],
  ]
));

// ══════════════════════════════════════
// 3. LAYER 0: REPO INTELLIGENCE
// ══════════════════════════════════════
body.push(h1("3. Layer 0: Repo Intelligence"));
body.push(para("Это ключевой недостающий слой. Без него пайплайн тратит LLM-вызовы на реконструкцию того, что можно вычислить детерминистически. Layer 0 строится один раз при пуше в дефолтную ветку и обновляется инкрементально."));

body.push(h2("3.1. AST Indexer (tree-sitter)"));
body.push(para("tree-sitter парсит каждый файл репозитория и извлекает: функции (имя, сигнатура, позиция), классы (имя, методы, позиция), импорты (откуда, что), экспорты (что доступно извне), вызовы (кто кого вызывает). Результат сохраняется в JSON-файл на файловую систему (или в PostgreSQL для persistence). Это детерминистическая операция \u2014 ноль галлюцинаций, полная воспроизводимость."));

body.push(...codeBlock([
  "// src/repo-intelligence/ast-indexer.ts",
  "import Parser from 'tree-sitter';",
  "import TypeScript from 'tree-sitter-typescript';",
  "import Python from 'tree-sitter-python';",
  "",
  "interface SymbolInfo {",
  "  name: string;",
  "  kind: 'function' | 'class' | 'method' | 'variable' | 'import' | 'export';",
  "  file: string;",
  "  startLine: number;",
  "  endLine: number;",
  "  signature?: string;",
  "  callsTo: string[];",
  "  calledBy: string[];  // заполняется на втором проходе",
  "}",
  "",
  "export async function indexRepository(repoPath: string): Promise<SymbolInfo[]> {",
  "  const symbols: SymbolInfo[] = [];",
  "  const files = await glob('**/*.{ts,tsx,py,go,rs}', { cwd: repoPath });",
  "  for (const file of files) {",
  "    const parser = new Parser();",
  "    parser.setLanguage(selectLanguage(file));",
  "    const tree = parser.parse(await fs.readFile(path.join(repoPath, file), 'utf-8'));",
  "    extractSymbols(tree.rootNode, file, symbols);",
  "  }",
  "  // Второй проход: заполнить calledBy",
  "  resolveCallGraph(symbols);",
  "  return symbols;",
  "}",
]));

body.push(h2("3.2. Dependency Graph (Neo4j)"));
body.push(para("Symbol graph хранится в Neo4j для быстрого traversal запросов. Когда приходит MR, Risk Map не угадывает зависимости через FILE_REQUEST \u2014 он делает детерминистический Cypher-запрос: \u00abнайди все узлы, которые зависят от изменённых файлов\u00bb. Это O(1) вместо O(n) FILE_REQUEST итераций."));

body.push(...codeBlock([
  "// Cypher: трассировка рисков для MR",
  "MATCH (changed:Symbol)-[:IMPORTS|CALLS*1..3]->(dependent:Symbol)",
  "WHERE changed.file IN $changedFiles",
  "RETURN DISTINCT dependent.file AS file,",
  "       length(shortestPath((changed)-[:IMPORTS|CALLS*]->(dependent))) AS depth,",
  "       collect(DISTINCT dependent.name) AS affectedSymbols",
  "ORDER BY depth ASC",
]));

body.push(h2("3.3. Embedding Index (Qdrant)"));
body.push(para("Каждая функция и класс векторизуются через модель из уровня LLM_EMBEDDING_MODEL и сохраняются в Qdrant. Это позволяет делать semantic retrieval: \u00abкакие похожие паттерны уже есть в кодовой базе?\u00bb, \u00abкак этот модуль обычно интегрируется?\u00bb. Векторизация \u2014 фаза 2, но структура для неё закладывается сразу."));

body.push(h2("3.4. Инкрементальное обновление"));
body.push(para("При пуше в дефолтную ветку Temporal workflow запускает reindex: git diff определяет изменённые файлы, tree-sitter парсит только их, Neo4j обновляет только затронутые узлы и рёбра, Qdrant переэмбеддингует только изменённые символы. Полный reindex делается раз в неделю (cron workflow в Temporal) и при первой настройке нового репозитория."));

// ══════════════════════════════════════
// 4. ПАЙПЛАЙН
// ══════════════════════════════════════
body.push(h1("4. Pipeline: пошаговая реализация"));
body.push(h2("4.1. Workflow Overview"));
body.push(para("Основной Temporal workflow оркестрирует весь процесс. Каждый шаг \u2014 activity, который может быть LangGraph subgraph. Workflow управляет: условным выполнением (CoVe только при ESCALATE), параллельным выполнением (Triple Review), бюджетом (max LLM calls), таймаутами, retry logic."));

body.push(...codeBlock([
  "// src/workflows/review.workflow.ts",
  "export async function reviewWorkflow(input: ReviewInput): Promise<ReviewOutput> {",
  "  // Layer 1: Context Assembly",
  "  const context = await executeChildWorkflow(contextAssemblyWorkflow, {",
  "    args: [input],",
  "  });",
  "",
  "  // Budget gate",
  "  if (context.budgetEstimate > getMaxBudget()) {",
  "    throw new ApplicationFailure('Budget exceeded before reasoning');",
  "  }",
  "",
  "  // Layer 2: Triple Review (параллельно)",
  "  const [logic, risk, consistency] = await Promise.all([",
  "    executeActivity(tripleReviewActivity, {",
  "      args: [{ ...context, perspective: 'logic', modelTier: 'frontier' }],",
  "    }),",
  "    executeActivity(tripleReviewActivity, {",
  "      args: [{ ...context, perspective: 'risk', modelTier: 'frontier' }],",
  "    }),",
  "    executeActivity(tripleReviewActivity, {",
  "      args: [{ ...context, perspective: 'consistency', modelTier: 'base' }],",
  "    }),",
  "  ]);",
  "",
  "  // Consensus",
  "  const consensus = await executeActivity(consensusActivity, {",
  "    args: [{ logic, risk, consistency, modelTier: 'frontier' }],",
  "  });",
  "",
  "  // Layer 3: CoVe (только ESCALATE)",
  "  let verified = consensus;",
  "  if (consensus.escalateCount > 0 && isCoVeEnabled()) {",
  "    verified = await executeChildWorkflow(coveWorkflow, {",
  "      args: [{ findings: consensus.escalatedFindings, context, maxFindings: getCoVeMaxFindings() }],",
  "    });",
  "  }",
  "",
  "  // Layer 4: Report",
  "  return await executeActivity(reportActivity, {",
  "    args: [{ verified, context, modelTier: 'base' }],",
  "  });",
  "}",
]));

body.push(h2("4.2. Context Assembly (вместо Landscape Scan + Risk Map)"));
body.push(para("Context Assembly \u2014 это гибрид старых шагов Landscape Scan и Risk Map, но с опорой на Layer 0 вместо FILE_REQUEST loops. Код читает symbol graph из Neo4j, получает embeddings из Qdrant, скачивает дифф из GitLab. Landscape Scan по-прежнему нужен, но он становится лёгким: модель получает уже готовый symbol graph + dependency map и только формулирует PATTERNS / CONVENTIONS / INTENTIONAL, что занимает 1 LLM-вызов вместо 5-10 с FILE_REQUEST."));

body.push(h2("4.3. Triple Review: изменения"));
body.push(para("Triple Review остаётся, но получает детерминистический контекст вместо вероятностного. Risk Map больше не угадывает зависимости \u2014 он получает готовый traversal из Neo4j. Модель 2 (Risk) может сфокусироваться на анализе последствий вместо трассировки путей. Модель 3 (Consistency) получает из Qdrant семантически похожие паттерны в кодовой базе вместо угадывания."));
body.push(para("Распределение моделей по уровням: Logic и Risk используют Frontier (сложный reasoning), Consistency использует Base (паттерн-матчинг). Это экономит бюджет без потери качества: Consistency-ревьюер выполняет задачу сравнения с известными паттернами, что менее требовательно к reasoning capabilities."));

body.push(h2("4.4. CoVe: бюджетирование и опциональность"));
body.push(para("CoVe остаётся в пайплайне, но с ограничениями: включается только когда PIPELINE_COVE_ENABLED=true, обрабатывает максимум PIPELINE_COVE_MAX_FINDINGS finding-ов, пропускается если бюджет исчерпан. Для contested findings с высоким confidence (больше 0.7) CoVe можно опускать \u2014 достаточно пометить как contested в отчёте. Это снижает количество LLM-вызовов с потенциальных 15 до 3-6 в типичном MR."));

body.push(h2("4.5. Report: разделение на Format + Translate"));
body.push(para("Текущий Report шаг перегружен. Разделение: Format (Frontier) \u2014 формирует структурированный JSON с findings, severity маппингом и evidence anchors. Translate (Base) \u2014 переводит findings на русский с психологическими правилами. Это позволяет менять язык отчёта через ENV и разделять ответственность."));

// ══════════════════════════════════════
// 5. MCP SERVER
// ══════════════════════════════════════
body.push(h1("5. MCP Server"));
body.push(para("MCP (Model Context Protocol) сервер \u2014 это интерфейс, через который внешний AI-агент может запросить code review. Это не替代ляет GitLab webhook \u2014 это дополняет его. Агент может запросить: полное ревью сниппета, проверку конкретного risk, query к symbol graph, semantic search по кодовой базе."));

body.push(makeTable(
  ["MCP Tool", "\u041e\u043f\u0438\u0441\u0430\u043d\u0438\u0435", "\u041c\u043e\u0434\u0435\u043b\u044c"],
  [
    ["review_snippet", "Полное ревью кода (diff или сниппет)", "Полный pipeline"],
    ["check_risk", "Трассировка рисков для изменённых файлов", "Risk Map only"],
    ["find_patterns", "Семантический поиск паттернов", "Qdrant query"],
    ["explain_symbol", "Объяснение символа в контексте кодовой базы", "Symbol graph + LLM"],
    ["query_graph", "Произвольный запрос к dependency graph", "Neo4j Cypher"],
  ]
));

body.push(...codeBlock([
  "// src/mcp/server.ts",
  "import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';",
  "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
  "",
  "const server = new McpServer({",
  "  name: 'ai-code-review',",
  "  version: '1.0.0',",
  "});",
  "",
  "server.tool('review_snippet',",
  "  { code: z.string(), language: z.string(), context: z.string().optional() },",
  "  async ({ code, language, context }) => {",
  "    const result = await temporalClient.workflow.start(",
  "      'reviewWorkflow',",
  "      { args: [{ diff: code, language, partialContext: context }] },",
  "    );",
  "    return { content: [{ type: 'text', text: JSON.stringify(result) }] };",
  "  }",
  ");",
]));

// ══════════════════════════════════════
// 6. СТРУКТУРА РЕПОЗИТОРИЯ
// ══════════════════════════════════════
body.push(h1("6. Структура репозитория"));
body.push(para("Монорепозиторий с чётким разделением на пакеты. Каждый пакет \u2014 независимый модуль с собственными тестами и типами. Это позволяет деплоить разные части независимо и переиспользовать модули."));

body.push(...codeBlock([
  "ai-code-review/",
  "\u251c\u2500\u2500 src/",
  "\u2502   \u251c\u2500\u2500 llm/                    # LLM клиент + tiers",
  "\u2502   \u2502   \u251c\u2500\u2500 tiers.ts              # Cheap/Base/Frontier/Embedding",
  "\u2502   \u2502   \u251c\u2500\u2500 client.ts             # OpenAI-compatible client",
  "\u2502   \u2502   \u2514\u2500\u2500 budget.ts             # Rate limiting + cost tracking",
  "\u2502   \u251c\u2500\u2500 repo-intelligence/       # Layer 0",
  "\u2502   \u2502   \u251c\u2500\u2500 ast-indexer.ts        # tree-sitter парсинг",
  "\u2502   \u2502   \u251c\u2500\u2500 graph-sync.ts         # Neo4j sync",
  "\u2502   \u2502   \u251c\u2500\u2500 embedding-sync.ts     # Qdrant sync",
  "\u2502   \u2502   \u2514\u2500\u2500 reindex.workflow.ts   # Temporal workflow",
  "\u2502   \u251c\u2500\u2500 pipeline/                # Layers 1-4",
  "\u2502   \u2502   \u251c\u2500\u2500 context-assembly/     # Context builder",
  "\u2502   \u2502   \u251c\u2500\u2500 triple-review/        # 3 LangGraph subgraphs",
  "\u2502   \u2502   \u251c\u2500\u2500 consensus/            # Aggregation graph",
  "\u2502   \u2502   \u251c\u2500\u2500 cove/                 # Verification subgraphs",
  "\u2502   \u2502   \u251c\u2500\u2500 report/               # Format + translate",
  "\u2502   \u2502   \u2514\u2500\u2500 review.workflow.ts    # Главный Temporal WF",
  "\u2502   \u251c\u2500\u2500 gitlab/                  # GitLab integration",
  "\u2502   \u2502   \u251c\u2500\u2500 webhook.ts            # MR event handler",
  "\u2502   \u2502   \u2514\u2500\u2500 api.ts                # Discussions + Notes API",
  "\u2502   \u251c\u2500\u2500 mcp/                     # MCP Server",
  "\u2502   \u2502   \u251c\u2500\u2500 server.ts             # MCP server setup",
  "\u2502   \u2502   \u2514\u2500\u2500 tools.ts              # Tool definitions",
  "\u2502   \u251c\u2500\u2500 feedback/                # Layer 5",
  "\u2502   \u2502   \u2514\u2500\u2500 tracker.ts            # Human review feedback",
  "\u2502   \u2514\u2500\u2500 config/                  # ENV + validation",
  "\u2502       \u251c\u2500\u2500 env.ts                # zod schema для ENV",
  "\u2502       \u2514\u2500\u2500 defaults.ts           # Дефолтные промпты",
  "\u251c\u2500\u2500 prompts/                 # Все промпты в отдельных файлах",
  "\u2502   \u251c\u2500\u2500 landscape.md",
  "\u2502   \u251c\u2500\u2500 risk-map.md",
  "\u2502   \u251c\u2500\u2500 review-logic.md",
  "\u2502   \u251c\u2500\u2500 review-risk.md",
  "\u2502   \u251c\u2500\u2500 review-consistency.md",
  "\u2502   \u251c\u2500\u2500 consensus.md",
  "\u2502   \u251c\u2500\u2500 cove-question.md",
  "\u2502   \u251c\u2500\u2500 cove-verify.md",
  "\u2502   \u251c\u2500\u2500 cove-verdict.md",
  "\u2502   \u2514\u2500\u2500 report.md",
  "\u251c\u2500\u2500 docker/",
  "\u2502   \u251c\u2500\u2500 Dockerfile",
  "\u2502   \u251c\u2500\u2500 docker-compose.yml     # Локальная разработка",
  "\u2502   \u2514\u2500\u2500 docker-compose.prod.yml # Продакшен",
  "\u251c\u2500\u2500 infra/                   # Dokploy / Swarm конфиг",
  "\u2502   \u251c\u2500\u2500 stack.yml",
  "\u2502   \u2514\u2500\u2500 .env.example",
  "\u251c\u2500\u2500 tests/",
  "\u251c\u2500\u2500 package.json",
  "\u251c\u2500\u2500 tsconfig.json",
  "\u2514\u2500\u2500 .env.example",
]));

// ══════════════════════════════════════
// 7. СТЕК
// ══════════════════════════════════════
body.push(h1("7. Стек технологий"));

body.push(makeTable(
  ["\u041a\u043e\u043c\u043f\u043e\u043d\u0435\u043d\u0442", "\u0422\u0435\u0445\u043d\u043e\u043b\u043e\u0433\u0438\u044f", "\u041e\u0431\u043e\u0441\u043d\u043e\u0432\u0430\u043d\u0438\u0435"],
  [
    ["Runtime", "Node.js 22 + TypeScript", "Temporal SDK нативный, MCP SDK нативный"],
    ["Orchestration", "Temporal", "Проверенный оркестратор с persistence, replay, signals"],
    ["Reasoning", "LangGraph", "Нативная поддержка LLM, state machines, conditional edges"],
    ["AST Parsing", "tree-sitter (wasm)", "Мультиязычность, скорость, детерминистичность"],
    ["Graph DB", "Neo4j", "Cypher для dependency traversal, визуализация"],
    ["Vector DB", "Qdrant", "Self-hosted, OpenAI-compatible API, фильтрация"],
    ["Relational DB", "PostgreSQL", "Feedback loop, audit log, pipeline runs"],
    ["LLM Gateway", "OpenAI-compatible API", "Универсальный интерфейс, swap провайдера через ENV"],
    ["GitLab", "REST API + Webhooks", "MR events, discussions, notes"],
    ["MCP", "@modelcontextprotocol/sdk", "Стандартный протокол для AI-агентов"],
    ["Deploy", "Dokploy + Docker Swarm", "Self-hosted, простой деплой через git push"],
    ["Config", "zod + dotenv", "Валидация ENV при старте, типобезопасность"],
  ]
));

// ══════════════════════════════════════
// 8. ФАЗЫ РЕАЛИЗАЦИИ
// ══════════════════════════════════════
body.push(h1("8. Фазы реализации"));

body.push(h2("8.1. Фаза 1: Foundation (2 недели)"));
body.push(para("Цель: работающий pipeline без Layer 0, который принимает MR из GitLab и выдаёт отчёт. Это MVP, который уже приносит пользу. Включает: ENV конфигурацию с zod-валидацией, LLM клиент с tier-ами, Temporal workflow (упрощённый, без Layer 0), GitLab webhook + API интеграция, Report генерация. В этой фазе Landscape Scan и Risk Map работают через FILE_REQUEST \u2014 как в текущем пайплайне, но уже с правильной оркестрацией через Temporal."));

body.push(makeTable(
  ["\u0417\u0430\u0434\u0430\u0447\u0430", "\u0418\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442", "\u041e\u0446\u0435\u043d\u043a\u0430"],
  [
    ["ENV config + zod", "dotenv + zod", "1 день"],
    ["LLM client + tiers", "openai SDK", "2 дня"],
    ["Temporal setup + basic workflow", "@temporalio/workflow", "3 дня"],
    ["GitLab webhook + API", "axios", "2 дня"],
    ["Triple Review (3 модели параллельно)", "LangGraph", "3 дня"],
    ["Consensus", "LangGraph", "1 день"],
    ["Report (JSON + русский)", "LLM", "2 дня"],
  ]
));

body.push(h2("8.2. Фаза 2: Repo Intelligence (2 недели)"));
body.push(para("Цель: заменить FILE_REQUEST loops на детерминистические запросы к pre-computed индексам. Это даёт наибольший ROI: качество Risk Map растёт на 60-80%, количество LLM-вызовов снижается в 3-5 раз, исчезают галлюцинации в dependency tracing. Включает: tree-sitter AST indexer, Neo4j integration + symbol graph, Qdrant integration + embeddings, reindex Temporal workflow, модификация Context Assembly для использования Layer 0."));

body.push(h2("8.3. Фаза 3: CoVe + Budget + MCP (2 недели)"));
body.push(para("Цель: добавить верификацию, бюджетный контроль и MCP-интерфейс. CoVe с ограничением на количество findings, budget gate на каждом шаге pipeline, MCP server с 5 инструментами. Эта фаза делает систему production-ready: она контролирует свои расходы и доступна через стандартный протокол для AI-агентов."));

body.push(h2("8.4. Фаза 4: Feedback Loop + Polish (1 неделя)"));
body.push(para("Цель: замкнуть цикл обучения. При resolve discussion в GitLab \u2014 записать результат (принято/отклонено) в PostgreSQL. Агрегировать статистику: какие типы findings отклоняются чаще всего, какой confidence у false positives. Использовать это для калибровки confidence thresholds и корректировки промптов. Также: мониторинг (Prometheus metrics), алерты (pipeline failures), документация API."));

// ══════════════════════════════════════
// 9. ДЕПЛОЙ
// ══════════════════════════════════════
body.push(h1("9. Деплой: Dokploy Swarm"));
body.push(para("Деплой через Dokploy на Docker Swarm. Это self-hosted решение с простым git-push деплоем. Каждый сервис \u2014 Docker контейнер с health check и restart policy."));

body.push(h2("9.1. Docker Compose (production)"));
body.push(...codeBlock([
  "# docker-compose.prod.yml",
  "services:",
  "  api:",
  "    build: .",
  "    command: node dist/main.js",
  "    env_file: .env",
  "    deploy:",
  "      replicas: 2",
  "      resources:",
  "        limits: { memory: 512M }",
  "    healthcheck:",
  "      test: ['CMD', 'curl', '-f', 'http://localhost:3000/health']",
  "      interval: 30s",
  "      timeout: 10s",
  "      retries: 3",
  "",
  "  temporal:",
  "    image: temporalio/auto-setup:latest",
  "    environment:",
  "      - DB=postgresql",
  "      - DB_PORT=5432",
  "      - POSTGRES_USER=temporal",
  "      - POSTGRES_PWD=${TEMPORAL_DB_PASSWORD}",
  "    volumes:",
  "      - temporal-data:/var/lib/temporal",
  "",
  "  neo4j:",
  "    image: neo4j:5-community",
  "    environment:",
  "      NEO4J_AUTH: ${NEO4J_USER}/${NEO4J_PASSWORD}",
  "    volumes:",
  "      - neo4j-data:/data",
  "",
  "  qdrant:",
  "    image: qdrant/qdrant:latest",
  "    volumes:",
  "      - qdrant-data:/qdrant/storage",
  "",
  "  postgres:",
  "    image: postgres:16-alpine",
  "    environment:",
  "      POSTGRES_DB: ai_code_review",
  "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}",
  "    volumes:",
  "      - pg-data:/var/lib/postgresql/data",
  "",
  "volumes:",
  "  temporal-data:",
  "  neo4j-data:",
  "  qdrant-data:",
  "  pg-data:",
]));

body.push(h2("9.2. ENV валидация при старте"));
body.push(para("Критически важный момент: приложение не стартует, если обязательные ENV-переменные не заданы. Валидация через zod-схему выполняется единожды при запуске. Если переменная отсутствует или невалидна \u2014 процесс завершается с понятным сообщением об ошибке. Никаких fallback-значений для критичных конфигов: LLM_BASE_URL, LLM_API_KEY, GITLAB_TOKEN \u2014 если их нет, система не должна работать (fail-fast)."));

body.push(...codeBlock([
  "// src/config/env.ts",
  "import { z } from 'zod';",
  "",
  "const envSchema = z.object({",
  "  // LLM Gateway",
  "  LLM_BASE_URL: z.string().url(),",
  "  LLM_API_KEY: z.string().min(1),",
  "",
  "  // Model Tiers (алиасы, не хардкод)",
  "  LLM_CHEAP_MODEL: z.string().min(1),",
  "  LLM_BASE_MODEL: z.string().min(1),",
  "  LLM_FRONTIER_MODEL: z.string().min(1),",
  "  LLM_EMBEDDING_MODEL: z.string().min(1),",
  "",
  "  // Tier Limits",
  "  LLM_CHEAP_MAX_TOKENS: z.coerce.number().default(2048),",
  "  LLM_BASE_MAX_TOKENS: z.coerce.number().default(4096),",
  "  LLM_FRONTIER_MAX_TOKENS: z.coerce.number().default(8192),",
  "  LLM_EMBEDDING_DIM: z.coerce.number().default(1536),",
  "",
  "  // Pipeline Budget",
  "  PIPELINE_MAX_LLM_CALLS: z.coerce.number().default(25),",
  "  PIPELINE_MAX_COST_USD: z.coerce.number().default(0.50),",
  "  PIPELINE_COVE_ENABLED: z.coerce.boolean().default(true),",
  "  PIPELINE_COVE_MAX_FINDINGS: z.coerce.number().default(5),",
  "",
  "  // Infrastructure",
  "  QDRANT_URL: z.string().url(),",
  "  NEO4J_URL: z.string().min(1),",
  "  NEO4J_USER: z.string().min(1),",
  "  NEO4J_PASSWORD: z.string().min(1),",
  "  GITLAB_URL: z.string().url(),",
  "  GITLAB_TOKEN: z.string().min(1),",
  "  TEMPORAL_URL: z.string().min(1),",
  "",
  "  // MCP",
  "  MCP_PORT: z.coerce.number().default(3001),",
  "  MCP_TRANSPORT: z.enum(['stdio', 'sse']).default('stdio'),",
  "});",
  "",
  "export const env = envSchema.parse(process.env);",
  "// Если парсинг падает \u2014 приложение не стартует. Это правильно.",
]));

// ══════════════════════════════════════
// 10. КЛЮЧЕВЫЕ РЕШЕНИЯ И КОМПРОМИССЫ
// ══════════════════════════════════════
body.push(h1("10. Ключевые решения и компромиссы"));

body.push(h2("10.1. Почему Temporal, а не чистый LangGraph"));
body.push(para("LangGraph отлично подходит для reasoning внутри одного шага, но не для оркестрации между шагами. Temporal даёт: persistence (workflow survives worker restart), replay (детерминистическое воспроизведение), signals (внешние события вроде human review), scheduling (cron для reindex), visibility (Web UI для мониторинга). LangGraph не даёт ни одного из этих механизмов из коробки. Комбинация Temporal + LangGraph = best of both worlds."));

body.push(h2("10.2. Почему Neo4j, а не PostgreSQL для graph"));
body.push(para("Dependency traversal \u2014 это графовый запрос. В PostgreSQL это рекурсивные CTE, которые работают медленно и сложно поддерживать. В Neo4j это один Cypher-запрос. Альтернатива \u2014 хранить graph в памяти (JSON), но это не масштабируется на репозитории с 10k+ файлов. Neo4j даёт: O(1) traversal, визуализацию (Browser UI), Cypher DSL для сложных запросов, ACID транзакции."));

body.push(h2("10.3. Почему tree-sitter, а не LSP"));
body.push(para("LSP (Language Server Protocol) даёт более точный анализ, но требует запущенного language server для каждого языка, сложнее в настройке и не работает offline. tree-sitter: работает offline, парсит любой файл за миллисекунды, поддерживает 40+ языков через WASM, не требует процесса-сервера. Для code review задачи достаточно AST + call graph \u2014 full type inference не нужен."));

body.push(h2("10.4. Честные ограничения"));
body.push(para("Система не будет идеально работать на: монорепозиториях с 100k+ файлов (tree-sitter медленный, Neo4j тяжёлый), проектах на экзотических языках без tree-sitter грамматики, MR с 5000+ строк диффа (контекст не влезет в context window). Для монорепозиториев нужен scoped indexing (только subtree). Для экзотических языков \u2014 fallback на regex-based extraction. Для огромных диффов \u2014 chunking с приоритизацией по risk score."));

// ── Body section ──
const bodySection = {
  properties: {
    type: SectionType.NEXT_PAGE,
    page: { size: pgSize, margin: pgMargin, pageNumbers: { start: 1, formatType: NumberFormat.DECIMAL } },
  },
  headers: {
    default: new Header({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "AI Code Review Pipeline \u2014 Architecture & Implementation Plan", size: 18, color: "808080" })] })] }),
  },
  footers: {
    default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: "808080" })] })] }),
  },
  children: body,
};

// ── Build document ──
const doc = new Document({
  styles: {
    default: {
      document: {
        run: { font: { ascii: "Calibri", eastAsia: "Microsoft YaHei" }, size: 24, color: c(P.body) },
        paragraph: { spacing: { line: 312 } },
      },
      heading1: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 32, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 360, after: 160, line: 312 } },
      },
      heading2: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 28, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 280, after: 120, line: 312 } },
      },
      heading3: {
        run: { font: { ascii: "Calibri", eastAsia: "SimHei" }, size: 26, bold: true, color: c(P.primary) },
        paragraph: { spacing: { before: 200, after: 100, line: 312 } },
      },
    },
  },
  numbering: {
    config: [],
  },
  sections: [coverSection, tocSection, bodySection],
});

// ── Write ──
const outPath = "/home/z/my-project/download/AI_Code_Review_Pipeline_Plan.docx";
Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(outPath, buf);
  console.log("Document written to:", outPath);
});
