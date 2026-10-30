"use strict";

require("dotenv").config();

const http = require("node:http");
const { Telegraf, Markup } = require("telegraf");

const {
  registerPlayer,
  getPlayer,
  addPoints,
  getTopPlayers,
  claimDaily,
  recordMessage,
  recordReply,
  getStats,
  logActivity,
  setChatLocked,
  closeDatabase
} = require("./db");

const { askGroq, clearHistory } = require("./ai");

const {
  normalizeArabic,
  getQuickReply
} = require("./personality");

// =====================================================
// الإعدادات
// =====================================================

const TOKEN = process.env.BOT_TOKEN;
const BOT_NAME = process.env.BOT_NAME || "ملك";
const PORT = Number(process.env.PORT || 10000);

const OWNER_ID = Number(process.env.OWNER_ID || 0);

const GROUP_COOLDOWN = Math.max(
  0,
  Number(process.env.GROUP_COOLDOWN_SECONDS || 25)
) * 1000;

const USER_COOLDOWN = Math.max(
  0,
  Number(process.env.USER_COOLDOWN_SECONDS || 5)
) * 1000;

const AI_ENABLED = process.env.AI_ENABLED !== "false";

if (!TOKEN) {
  console.error("خطأ: BOT_TOKEN غير موجود في ملف .env");
  process.exit(1);
}

if (AI_ENABLED && !process.env.GROQ_API_KEY) {
  console.warn(
    "تحذير: GROQ_API_KEY غير موجود. الردود الذكية لن تعمل."
  );
}

const bot = new Telegraf(TOKEN);

// =====================================================
// الحالة العامة
// =====================================================

const sessions = new Map();
const cooldowns = new Map();

let botId = null;
let shuttingDown = false;

// =====================================================
// أدوات مساعدة
// =====================================================

function displayName(user) {
  if (!user) return "صديقنا";

  return [
    user.first_name,
    user.last_name
  ].filter(Boolean).join(" ").trim() ||
    user.username ||
    "صديقنا";
}

function isGroup(ctx) {
  return ["group", "supergroup"].includes(ctx.chat?.type);
}

function randomItem(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function safeError(error) {
  console.error(
    error?.description ||
    error?.message ||
    error
  );
}

function isOwner(ctx) {
  return OWNER_ID > 0 &&
    Number(ctx.from?.id) === OWNER_ID;
}

async function isAdmin(ctx) {
  if (isOwner(ctx)) return true;
  if (!isGroup(ctx)) return false;

  try {
    const member = await ctx.telegram.getChatMember(
      ctx.chat.id,
      ctx.from.id
    );

    return [
      "creator",
      "administrator"
    ].includes(member.status);
  } catch {
    return false;
  }
}

async function requireAdmin(ctx) {
  if (!isGroup(ctx)) {
    await ctx.reply("الأمر ده متاح داخل المجموعات فقط.");
    return false;
  }

  if (!(await isAdmin(ctx))) {
    await ctx.reply("الأمر ده مخصص لمشرفي المجموعة.");
    return false;
  }

  return true;
}

async function botIsAdmin(ctx) {
  if (!botId) return false;

  try {
    const member = await ctx.telegram.getChatMember(
      ctx.chat.id,
      botId
    );

    return [
      "creator",
      "administrator"
    ].includes(member.status);
  } catch {
    return false;
  }
}

async function reply(ctx, message, extra) {
  const result = await ctx.reply(message, extra);

  try {
    recordReply(ctx.chat.id);
  } catch (error) {
    safeError(error);
  }

  return result;
}

function createSession(ctx, type, data = {}) {
  const id =
    `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  sessions.set(id, {
    id,
    type,
    chatId: String(ctx.chat.id),
    createdBy: ctx.from.id,
    answered: false,
    expiresAt: Date.now() + 5 * 60 * 1000,
    ...data
  });

  return id;
}

function findSession(id, chatId, type) {
  const session = sessions.get(id);

  if (!session) return null;

  if (session.chatId !== String(chatId)) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }

  if (type && session.type !== type) return null;

  return session;
}

// =====================================================
// بنك الأسئلة
// =====================================================

const QUIZZES = [
  {
    q: "كم عدد أركان الإسلام؟",
    o: ["ثلاثة", "خمسة", "ستة", "سبعة"],
    a: 1,
    e: "أركان الإسلام خمسة."
  },
  {
    q: "ما عاصمة مصر؟",
    o: ["القاهرة", "الإسكندرية", "الأقصر", "أسوان"],
    a: 0,
    e: "القاهرة هي عاصمة مصر."
  },
  {
    q: "ما أكبر كوكب في المجموعة الشمسية؟",
    o: ["الأرض", "المريخ", "المشتري", "زحل"],
    a: 2,
    e: "المشتري هو أكبر كواكب المجموعة الشمسية."
  },
  {
    q: "ما الكوكب المعروف بالكوكب الأحمر؟",
    o: ["الزهرة", "المريخ", "عطارد", "نبتون"],
    a: 1,
    e: "المريخ يبدو أحمر بسبب أكاسيد الحديد."
  },
  {
    q: "كم يوما في السنة العادية؟",
    o: ["360", "364", "365", "366"],
    a: 2,
    e: "السنة العادية تحتوي على 365 يوما."
  },
  {
    q: "ما الحيوان المعروف بسفينة الصحراء؟",
    o: ["الحصان", "الجمل", "الفيل", "الغزال"],
    a: 1,
    e: "الجمل يستطيع تحمل ظروف الصحراء."
  },
  {
    q: "ما الغاز الذي تمتصه النباتات في البناء الضوئي؟",
    o: ["الأكسجين", "الهيدروجين", "ثاني أكسيد الكربون", "الهيليوم"],
    a: 2,
    e: "تمتص النباتات ثاني أكسيد الكربون."
  },
  {
    q: "كم دقيقة في الساعة؟",
    o: ["30", "45", "60", "90"],
    a: 2,
    e: "الساعة تحتوي على 60 دقيقة."
  },
  {
    q: "ما عاصمة اليابان؟",
    o: ["بكين", "سيول", "طوكيو", "بانكوك"],
    a: 2,
    e: "طوكيو هي عاصمة اليابان."
  },
  {
    q: "كم ضلع للمثلث؟",
    o: ["اثنان", "ثلاثة", "أربعة", "خمسة"],
    a: 1,
    e: "للمثلث ثلاثة أضلاع."
  },
  {
    q: "ما أسرع حيوان بري؟",
    o: ["الأسد", "الفهد", "الحصان", "النمر"],
    a: 1,
    e: "الفهد هو أسرع الحيوانات البرية."
  },
  {
    q: "ما أكبر محيط في العالم؟",
    o: ["الأطلسي", "الهندي", "الهادئ", "المتجمد"],
    a: 2,
    e: "المحيط الهادئ هو الأكبر مساحة."
  },
  {
    q: "كم عدد قارات العالم في التقسيم الشائع؟",
    o: ["خمسة", "ستة", "سبعة", "ثمانية"],
    a: 2,
    e: "التقسيم الشائع يتضمن سبع قارات."
  },
  {
    q: "ما العضو المسؤول عن ضخ الدم؟",
    o: ["الرئة", "القلب", "الكبد", "المعدة"],
    a: 1,
    e: "القلب يضخ الدم إلى أنحاء الجسم."
  },
  {
    q: "ما وحدة قياس القوة؟",
    o: ["الجول", "النيوتن", "الواط", "الأمبير"],
    a: 1,
    e: "تقاس القوة بوحدة النيوتن."
  },
  {
    q: "ما ناتج 12 × 8؟",
    o: ["86", "92", "96", "108"],
    a: 2,
    e: "12 × 8 = 96."
  },
  {
    q: "من مؤلف رواية البؤساء؟",
    o: ["فيكتور هوجو", "نجيب محفوظ", "تولستوي", "شكسبير"],
    a: 0,
    e: "فيكتور هوجو هو مؤلف رواية البؤساء."
  },
  {
    q: "في أي قارة تقع البرازيل؟",
    o: ["آسيا", "أفريقيا", "أمريكا الجنوبية", "أوروبا"],
    a: 2,
    e: "تقع البرازيل في أمريكا الجنوبية."
  },
  {
    q: "ما اللغة الرسمية في البرازيل؟",
    o: ["الإسبانية", "البرتغالية", "الإنجليزية", "الفرنسية"],
    a: 1,
    e: "البرتغالية هي اللغة الرسمية."
  },
  {
    q: "كم عدد حروف اللغة العربية؟",
    o: ["26", "27", "28", "29"],
    a: 2,
    e: "عدد حروف الهجاء العربية 28 حرفا."
  },
  {
    q: "ما أكبر عضو في جسم الإنسان؟",
    o: ["القلب", "الكبد", "الجلد", "الرئة"],
    a: 2,
    e: "الجلد هو أكبر أعضاء جسم الإنسان."
  },
  {
    q: "ما الكوكب الأقرب إلى الشمس؟",
    o: ["الأرض", "عطارد", "الزهرة", "المريخ"],
    a: 1,
    e: "عطارد هو أقرب الكواكب إلى الشمس."
  },
  {
    q: "ما اسم عملية صنع النبات لغذائه؟",
    o: ["التنفس", "البناء الضوئي", "التبخر", "التكاثف"],
    a: 1,
    e: "تسمى هذه العملية البناء الضوئي."
  },
  {
    q: "كم عدد ألوان قوس قزح تقليديا؟",
    o: ["خمسة", "ستة", "سبعة", "ثمانية"],
    a: 2,
    e: "تقسم ألوان قوس قزح تقليديا إلى سبعة."
  },
  {
    q: "ما عاصمة السعودية؟",
    o: ["جدة", "مكة", "الرياض", "المدينة"],
    a: 2,
    e: "الرياض هي عاصمة المملكة العربية السعودية."
  },
  {
    q: "ما البحر الذي يفصل بين أجزاء من أفريقيا وأوروبا؟",
    o: ["الأحمر", "المتوسط", "العربي", "الأسود"],
    a: 1,
    e: "البحر المتوسط يقع بين القارتين."
  },
  {
    q: "ما ناتج 144 ÷ 12؟",
    o: ["10", "11", "12", "14"],
    a: 2,
    e: "144 ÷ 12 = 12."
  },
  {
    q: "ما المعدن السائل في درجة حرارة الغرفة؟",
    o: ["الحديد", "الزئبق", "النحاس", "الذهب"],
    a: 1,
    e: "الزئبق معدن سائل في الظروف المعتادة."
  },
  {
    q: "كم لاعبًا في فريق كرة القدم داخل الملعب؟",
    o: ["9", "10", "11", "12"],
    a: 2,
    e: "يتكون الفريق من 11 لاعبا داخل الملعب."
  },
  {
    q: "ما أكبر صحراء حارة في العالم؟",
    o: ["جوبي", "الصحراء الكبرى", "كالاهاري", "أتاكاما"],
    a: 1,
    e: "الصحراء الكبرى هي أكبر صحراء حارة."
  }
];

// =====================================================
// بنك الفوازير
// =====================================================

const RIDDLES = [
  {
    q: "شيء كلما أخذت منه كبر، فما هو؟",
    a: ["الحفرة"],
    e: "كلما أخذت من التراب اتسعت الحفرة."
  },
  {
    q: "له أسنان ولا يعض، فما هو؟",
    a: ["المشط"],
    e: "المشط له أسنان لكنه لا يعض."
  },
  {
    q: "يمشي بلا أرجل ويبكي بلا عيون، فما هو؟",
    a: ["السحاب", "الغيم"],
    e: "السحاب يتحرك في السماء وينزل المطر."
  },
  {
    q: "ما الشيء الذي يكتب ولا يقرأ؟",
    a: ["القلم"],
    e: "القلم نكتب به."
  },
  {
    q: "بيت ليس له أبواب ولا نوافذ، فما هو؟",
    a: ["بيت الشعر", "الشعر"],
    e: "المقصود بيت الشعر."
  },
  {
    q: "ما الشيء الذي كلما زاد نقص؟",
    a: ["العمر"],
    e: "كلما زاد عمر الإنسان قل ما تبقى منه."
  },
  {
    q: "له رقبة وليس له رأس، فما هو؟",
    a: ["الزجاجة", "القارورة"],
    e: "الزجاجة لها رقبة."
  },
  {
    q: "ما الشيء الذي يسمع بلا أذن ويتكلم بلا لسان؟",
    a: ["الهاتف", "التليفون"],
    e: "الهاتف ينقل الأصوات."
  },
  {
    q: "ما الشيء الذي له عين واحدة ولا يرى؟",
    a: ["الإبرة"],
    e: "عين الإبرة هي فتحتها."
  },
  {
    q: "ما الشيء الذي يملأ الغرفة ولا يشغل حيزا؟",
    a: ["الضوء", "النور"],
    e: "الضوء ينتشر في الغرفة."
  },
  {
    q: "ما الشيء الذي إذا نطقته كسرته؟",
    a: ["الصمت"],
    e: "عندما تتكلم ينتهي الصمت."
  },
  {
    q: "ما الشيء الذي يجري ولا يمشي؟",
    a: ["الماء", "النهر"],
    e: "الماء يجري في النهر."
  },
  {
    q: "ما الشيء الذي لا يدخل إلا إذا ضربته على رأسه؟",
    a: ["المسمار"],
    e: "المسمار يدخل بالطرق عليه."
  },
  {
    q: "ما الشيء الذي له وجه ويدان ولا يملك قدما؟",
    a: ["الساعة"],
    e: "للساعة وجه وعقارب."
  },
  {
    q: "ما الشيء الذي تذبحه وتبكي عليه؟",
    a: ["البصل"],
    e: "البصل يجعل العين تدمع عند تقطيعه."
  },
  {
    q: "ما الشيء الذي له مفاتيح ولا يفتح الأبواب؟",
    a: ["البيانو", "لوحة المفاتيح"],
    e: "المقصود مفاتيح البيانو."
  },
  {
    q: "ما الشيء الذي كلما غسلته اتسخ؟",
    a: ["الماء"],
    e: "الماء المستخدم في الغسيل يحمل الأوساخ."
  },
  {
    q: "ما الشيء الذي يكتب به ولا يتكلم؟",
    a: ["القلم"],
    e: "القلم أداة للكتابة."
  }
];

// =====================================================
// مركز الألعاب
// =====================================================

function gameMenu() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("معلومات عامة", "game:quiz"),
      Markup.button.callback("فوازير", "game:riddle")
    ],
    [
      Markup.button.callback("حساب سريع", "game:math"),
      Markup.button.callback("خمن الرقم", "game:guess")
    ],
    [
      Markup.button.callback("نقاطي", "game:points"),
      Markup.button.callback("المتصدرون", "game:top")
    ]
  ]);
}

async function showGames(ctx) {
  await reply(
    ctx,
    "أهلا بك في مركز الألعاب.\n\n" +
    "اختار التحدي اللي تحبه.\n" +
    "كل إجابة صحيحة تمنحك 10 نقاط.\n" +
    "مدة الجولة خمس دقائق.",
    gameMenu()
  );
}

async function startQuiz(ctx) {
  const question = randomItem(QUIZZES);

  const id = createSession(ctx, "quiz", {
    question
  });

  const rows = question.o.map((option, index) => [
    Markup.button.callback(
      option,
      `answer:${id}:${index}`
    )
  ]);

  rows.push([
    Markup.button.callback(
      "إلغاء الجولة",
      `cancel:${id}`
    )
  ]);

  await reply(
    ctx,
    `مسابقة معلومات عامة\n\n${question.q}\n\n` +
    "اختر الإجابة الصحيحة.",
    Markup.inlineKeyboard(rows)
  );
}

async function startRiddle(ctx) {
  const question = randomItem(RIDDLES);

  const id = createSession(ctx, "riddle", {
    question
  });

  await reply(
    ctx,
    `فزورة جديدة\n\n${question.q}\n\n` +
    "اكتب إجابتك في رسالة عادية. أمامك خمس دقائق.",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "إلغاء الجولة",
          `cancel:${id}`
        )
      ]
    ])
  );
}

async function startMath(ctx) {
  const a = Math.floor(Math.random() * 30) + 5;
  const b = Math.floor(Math.random() * 20) + 2;
  const operation = randomItem(["+", "-", "×"]);

  let answer;

  if (operation === "+") answer = a + b;
  if (operation === "-") answer = a - b;
  if (operation === "×") answer = a * b;

  const id = createSession(ctx, "math", {
    answer: String(answer)
  });

  await reply(
    ctx,
    `تحدي الحساب السريع\n\n` +
    `ما ناتج ${a} ${operation} ${b} ؟\n\n` +
    "اكتب الإجابة."
  );
}

async function startGuess(ctx) {
  const secret = Math.floor(Math.random() * 10) + 1;

  const id = createSession(ctx, "guess", {
    answer: String(secret)
  });

  const rows = [];

  for (let number = 1; number <= 10; number += 2) {
    rows.push([
      Markup.button.callback(
        String(number),
        `guess:${id}:${number}`
      ),
      Markup.button.callback(
        String(number + 1),
        `guess:${id}:${number + 1}`
      )
    ]);
  }

  await reply(
    ctx,
    "خمن الرقم السري.\n\nاختار رقما من 1 إلى 10.",
    Markup.inlineKeyboard(rows)
  );
}

async function showPoints(ctx) {
  const player = getPlayer(ctx.chat.id, ctx.from);

  await reply(
    ctx,
    `رصيدك الحالي: ${player.points} نقطة.\n` +
    `عدد مرات الفوز: ${player.wins}.\n` +
    `عدد الجولات: ${player.played}.`
  );
}

async function showTop(ctx) {
  const top = getTopPlayers(ctx.chat.id, 10);

  if (!top.length) {
    return reply(
      ctx,
      "لسه مفيش متصدرين. ابدأ أول تحدي."
    );
  }

  const lines = top.map((player, index) => {
    return `${index + 1}. ${player.display_name} — ${player.points} نقطة`;
  });

  await reply(
    ctx,
    "أفضل اللاعبين في المجموعة\n\n" +
    lines.join("\n")
  );
}

async function giveGameReward(ctx, session, explanation) {
  if (session.answered) return;

  session.answered = true;

  const player = addPoints(
    ctx.chat.id,
    ctx.from,
    10,
    true
  );

  logActivity(
    ctx.chat.id,
    ctx.from.id,
    `${session.type}_win`
  );

  await reply(
    ctx,
    `إجابة صحيحة يا ${displayName(ctx.from)}.\n\n` +
    `${explanation || "أحسنت!"}\n\n` +
    `ربحت 10 نقاط. رصيدك الآن ${player.points} نقطة.`
  );
}

// =====================================================
// أوامر البداية والمساعدة
// =====================================================

bot.start(async ctx => {
  registerPlayer(ctx.chat.id, ctx.from);

  logActivity(ctx.chat.id, ctx.from.id, "start");

  await reply(
    ctx,
    `أهلا يا ${displayName(ctx.from)}.\n\n` +
    `أنا ${BOT_NAME}، مساعدة ذكية أقدر أساعدك في الدراسة والمعلومات والأسئلة والألعاب.\n\n` +
    "اكتب سؤالك مباشرة أو افتح مركز الألعاب.",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "مركز الألعاب",
          "menu:games"
        )
      ],
      [
        Markup.button.callback(
          "رصيد النقاط",
          "menu:points"
        )
      ],
      [
        Markup.button.callback(
          "المتصدرون",
          "menu:top"
        )
      ],
      [
        Markup.button.callback(
          "المساعدة",
          "menu:help"
        )
      ]
    ])
  );
});

bot.command("help", async ctx => {
  await reply(
    ctx,
    "أوامر ملك\n\n" +
    "/start بداية الاستخدام\n" +
    "/help المساعدة\n" +
    "/games مركز الألعاب\n" +
    "/quiz مسابقة معلومات عامة\n" +
    "/riddle فزورة جديدة\n" +
    "/math تحدي الحساب\n" +
    "/guess خمن الرقم\n" +
    "/points رصيدك\n" +
    "/daily المكافأة اليومية\n" +
    "/top المتصدرون\n" +
    "/id معرفة المعرفات\n" +
    "/resetai مسح سياق محادثتك مع ملك\n\n" +
    "أوامر الإدارة داخل المجموعات:\n" +
    "قفل الدردشة\n" +
    "فتح الدردشة\n" +
    "إزالة مع الرد على رسالة\n" +
    "طرد مع الرد على رسالة"
  );
});

bot.command("games", showGames);
bot.command("quiz", startQuiz);
bot.command("riddle", startRiddle);
bot.command("math", startMath);
bot.command("guess", startGuess);
bot.command("points", showPoints);
bot.command("top", showTop);

bot.command("daily", async ctx => {
  const result = claimDaily(ctx.chat.id, ctx.from);

  if (!result.ok) {
    return reply(
      ctx,
      result.message || "تعذر الحصول على المكافأة."
    );
  }

  await reply(
    ctx,
    `مبروك! حصلت على 20 نقطة كمكافأة يومية.\n` +
    `رصيدك الآن ${result.player.points} نقطة.`
  );
});

bot.command("id", async ctx => {
  await reply(
    ctx,
    `معرف حسابك: ${ctx.from.id}\n` +
    `معرف المحادثة: ${ctx.chat.id}`
  );
});

bot.command("resetai", async ctx => {
  clearHistory(ctx.chat.id, ctx.from.id);

  await reply(
    ctx,
    "تم مسح سياق محادثتك السابقة. نبدأ من جديد."
  );
});

// =====================================================
// أزرار القوائم
// =====================================================

bot.action("menu:games", async ctx => {
  await ctx.answerCbQuery();
  await showGames(ctx);
});

bot.action("menu:points", async ctx => {
  await ctx.answerCbQuery();
  await showPoints(ctx);
});

bot.action("menu:top", async ctx => {
  await ctx.answerCbQuery();
  await showTop(ctx);
});

bot.action("menu:help", async ctx => {
  await ctx.answerCbQuery();
  await reply(ctx, "اكتب /help لمعرفة الأوامر المتاحة.");
});

bot.action("game:quiz", async ctx => {
  await ctx.answerCbQuery();
  await startQuiz(ctx);
});

bot.action("game:riddle", async ctx => {
  await ctx.answerCbQuery();
  await startRiddle(ctx);
});

bot.action("game:math", async ctx => {
  await ctx.answerCbQuery();
  await startMath(ctx);
});

bot.action("game:guess", async ctx => {
  await ctx.answerCbQuery();
  await startGuess(ctx);
});

bot.action("game:points", async ctx => {
  await ctx.answerCbQuery();
  await showPoints(ctx);
});

bot.action("game:top", async ctx => {
  await ctx.answerCbQuery();
  await showTop(ctx);
});

// =====================================================
// إجابات المسابقات
// =====================================================

bot.action(/^answer:([^:]+):(\d+)$/, async ctx => {
  const id = ctx.match[1];
  const selected = Number(ctx.match[2]);

  const session = findSession(
    id,
    ctx.chat.id,
    "quiz"
  );

  if (!session) {
    return ctx.answerCbQuery(
      "الجولة انتهت أو غير موجودة.",
      { show_alert: true }
    );
  }

  if (session.answered) {
    return ctx.answerCbQuery("تم حسم الجولة بالفعل.");
  }

  if (selected === session.question.a) {
    await ctx.answerCbQuery("إجابة صحيحة!");

    session.answered = true;

    const player = addPoints(
      ctx.chat.id,
      ctx.from,
      10,
      true
    );

    logActivity(ctx.chat.id, ctx.from.id, "quiz_win");

    try {
      await ctx.editMessageText(
        `إجابة صحيحة يا ${displayName(ctx.from)}.\n\n` +
        `${session.question.e}\n\n` +
        `ربحت 10 نقاط. رصيدك الآن ${player.points} نقطة.`
      );
    } catch {
      await reply(
        ctx,
        `إجابة صحيحة! ربحت 10 نقاط. رصيدك ${player.points}.`
      );
    }
  } else {
    await ctx.answerCbQuery(
      "إجابة غير صحيحة. حاول مرة أخرى.",
      { show_alert: true }
    );
  }
});

bot.action(/^guess:([^:]+):(\d+)$/, async ctx => {
  const id = ctx.match[1];
  const number = ctx.match[2];

  const session = findSession(
    id,
    ctx.chat.id,
    "guess"
  );

  if (!session) {
    return ctx.answerCbQuery(
      "الجولة انتهت.",
      { show_alert: true }
    );
  }

  if (session.answered) {
    return ctx.answerCbQuery("تم حسم الجولة.");
  }

  if (number === session.answer) {
    await ctx.answerCbQuery("تخمين صحيح!");

    session.answered = true;

    const player = addPoints(
      ctx.chat.id,
      ctx.from,
      10,
      true
    );

    try {
      await ctx.editMessageText(
        `أحسنت يا ${displayName(ctx.from)}!\n` +
        `خمنت الرقم الصحيح وربحت 10 نقاط.\n` +
        `رصيدك الحالي ${player.points} نقطة.`
      );
    } catch {
      await reply(ctx, "تخمين صحيح! ربحت 10 نقاط.");
    }
  } else {
    await ctx.answerCbQuery(
      "مش هو الرقم، جرب تاني."
    );
  }
});

bot.action(/^cancel:(.+)$/, async ctx => {
  const id = ctx.match[1];

  const session = findSession(
    id,
    ctx.chat.id
  );

  if (!session) {
    return ctx.answerCbQuery("الجولة غير موجودة.");
  }

  if (
    session.createdBy !== ctx.from.id &&
    !(await isAdmin(ctx))
  ) {
    return ctx.answerCbQuery(
      "صاحب الجولة أو المشرف فقط يستطيع إلغاءها.",
      { show_alert: true }
    );
  }

  sessions.delete(id);

  await ctx.answerCbQuery("تم إلغاء الجولة.");

  try {
    await ctx.editMessageText("تم إلغاء هذه الجولة.");
  } catch {}
});

// =====================================================
// قفل وفتح المجموعة
// =====================================================

async function lockChat(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (!(await botIsAdmin(ctx))) {
    return reply(
      ctx,
      "لازم تضيفيني مشرفة في المجموعة حتى أقدر أقفل الدردشة."
    );
  }

  try {
    await ctx.telegram.setChatPermissions(
      ctx.chat.id,
      {
        can_send_messages: false,
        can_send_audios: false,
        can_send_documents: false,
        can_send_photos: false,
        can_send_videos: false,
        can_send_video_notes: false,
        can_send_voice_notes: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false
      }
    );

    setChatLocked(ctx.chat.id, true);

    logActivity(ctx.chat.id, ctx.from.id, "chat_locked");

    await reply(
      ctx,
      "تم قفل الدردشة. لا يستطيع الأعضاء إرسال الرسائل الآن."
    );
  } catch (error) {
    safeError(error);

    await reply(
      ctx,
      "لم أستطع قفل الدردشة. تأكد من صلاحياتي كمشرفة."
    );
  }
}

async function unlockChat(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (!(await botIsAdmin(ctx))) {
    return reply(
      ctx,
      "لازم أكون مشرفة في المجموعة حتى أقدر أفتح الدردشة."
    );
  }

  try {
    await ctx.telegram.setChatPermissions(
      ctx.chat.id,
      {
        can_send_messages: true,
        can_send_audios: true,
        can_send_documents: true,
        can_send_photos: true,
        can_send_videos: true,
        can_send_video_notes: true,
        can_send_voice_notes: true,
        can_send_polls: true,
        can_send_other_messages: true,
        can_add_web_page_previews: true
      }
    );

    setChatLocked(ctx.chat.id, false);

    logActivity(ctx.chat.id, ctx.from.id, "chat_unlocked");

    await reply(
      ctx,
      "تم فتح الدردشة. يمكن للأعضاء التحدث الآن."
    );
  } catch (error) {
    safeError(error);

    await reply(
      ctx,
      "لم أستطع فتح الدردشة. تأكد من صلاحياتي."
    );
  }
}

// =====================================================
// الحذف والطرد
// =====================================================

async function getReplyTarget(ctx) {
  const message = ctx.message?.reply_to_message;
  const target = message?.from;

  if (!target) {
    await reply(
      ctx,
      "لازم تعمل رد على رسالة العضو الأول."
    );

    return null;
  }

  if (target.is_bot || target.id === botId) {
    await reply(ctx, "لا يمكن تنفيذ الإجراء على بوت.");
    return null;
  }

  if (target.id === ctx.from.id) {
    await reply(ctx, "لا يمكنك تنفيذ الإجراء على نفسك.");
    return null;
  }

  try {
    const member = await ctx.telegram.getChatMember(
      ctx.chat.id,
      target.id
    );

    if (
      member.status === "creator" ||
      member.status === "administrator"
    ) {
      await reply(
        ctx,
        "لا يمكن تنفيذ الإجراء على مشرف المجموعة."
      );

      return null;
    }
  } catch {
    await reply(
      ctx,
      "تعذر التحقق من حالة العضو."
    );

    return null;
  }

  return target;
}

async function removeRepliedMessage(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (!(await botIsAdmin(ctx))) {
    return reply(
      ctx,
      "يجب أن أكون مشرفة ولدي صلاحية حذف الرسائل."
    );
  }

  const target = ctx.message?.reply_to_message;

  if (!target) {
    return reply(
      ctx,
      "اعمل رد على الرسالة ثم اكتب إزالة."
    );
  }

  try {
    await ctx.telegram.deleteMessage(
      ctx.chat.id,
      target.message_id
    );

    logActivity(
      ctx.chat.id,
      ctx.from.id,
      "message_deleted"
    );

    await reply(ctx, "تم حذف الرسالة.");
  } catch (error) {
    safeError(error);

    await reply(
      ctx,
      "تعذر حذف الرسالة. تأكد من صلاحياتي."
    );
  }
}

async function kickRepliedMember(ctx) {
  if (!(await requireAdmin(ctx))) return;

  if (!(await botIsAdmin(ctx))) {
    return reply(
      ctx,
      "يجب أن أكون مشرفة ولدي صلاحية حظر الأعضاء."
    );
  }

  const target = await getReplyTarget(ctx);
  if (!target) return;

  try {
    await ctx.telegram.banChatMember(
      ctx.chat.id,
      target.id
    );

    await ctx.telegram.unbanChatMember(
      ctx.chat.id,
      target.id,
      { only_if_banned: true }
    );

    logActivity(
      ctx.chat.id,
      ctx.from.id,
      "member_kicked"
    );

    await reply(
      ctx,
      `تم طرد ${displayName(target)} من المجموعة.`
    );
  } catch (error) {
    safeError(error);

    await reply(
      ctx,
      "تعذر طرد العضو. راجع صلاحيات المشرفين."
    );
  }
}

// =====================================================
// أوامر الإدارة العربية والإنجليزية
// =====================================================

bot.hears(
  /^(قفل الدردشه|قفل الدردشة|اقفل الدردشه|اقفل الدردشة)$/i,
  lockChat
);

bot.hears(
  /^(فتح الدردشه|فتح الدردشة|افتح الدردشه|افتح الدردشة)$/i,
  unlockChat
);

bot.hears(
  /^(ازاله|إزالة|حذف)$/i,
  removeRepliedMessage
);

bot.hears(
  /^(طرد|اطرد)$/i,
  kickRepliedMember
);

bot.command("lock", lockChat);
bot.command("unlock", unlockChat);
bot.command("kick", kickRepliedMember);
bot.command("delete", removeRepliedMessage);

// =====================================================
// استقبال إجابات الفوازير والحساب
// =====================================================

bot.on("text", async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return next();

  const text = ctx.message.text.trim();

  if (!text || text.startsWith("/")) return next();

  const normalized = normalizeArabic(text);

  for (const [id, session] of sessions.entries()) {
    if (
      session.chatId !== String(ctx.chat.id) ||
      session.answered ||
      session.expiresAt < Date.now()
    ) {
      continue;
    }

    if (session.type === "riddle") {
      const accepted =
        session.question.a.map(normalizeArabic);

      if (accepted.includes(normalized)) {
        await giveGameReward(
          ctx,
          session,
          session.question.e
        );

        return;
      }
    }

    if (session.type === "math") {
      if (normalized === normalizeArabic(session.answer)) {
        await giveGameReward(ctx, session, "أحسنت في الحساب.");
        return;
      }
    }
  }

  return next();
});

// =====================================================
// الردود الذكية
// =====================================================

function shouldAnswerInGroup(ctx, text) {
  const mentioned =
    /ملك|malak/i.test(text);

  const repliedToBot =
    ctx.message.reply_to_message?.from?.id === botId;

  return mentioned || repliedToBot;
}

bot.on("text", async (ctx, next) => {
  if (!ctx.from || ctx.from.is_bot) return next();

  const text = ctx.message.text.trim();

  if (!text || text.startsWith("/")) return next();

  // تسجيل اللاعب والرسالة
  registerPlayer(ctx.chat.id, ctx.from);
  recordMessage(ctx.chat.id);

  // الردود الثابتة
  const quickReply = getQuickReply(text);

  if (quickReply) {
    return reply(ctx, quickReply);
  }

  // لا ترد ملك على كل رسائل المجموعة.
  if (
    isGroup(ctx) &&
    !shouldAnswerInGroup(ctx, text)
  ) {
    return next();
  }

  if (!AI_ENABLED) {
    return reply(
      ctx,
      "الرد الذكي متوقف حاليا."
    );
  }

  const key = `${ctx.chat.id}:${ctx.from.id}`;
  const now = Date.now();

  const previous = cooldowns.get(key) || 0;
  const cooldown = isGroup(ctx)
    ? GROUP_COOLDOWN
    : USER_COOLDOWN;

  if (now - previous < cooldown) {
    return reply(
      ctx,
      "استنى لحظة صغيرة، أنا بجهز لك الإجابة."
    );
  }

  cooldowns.set(key, now);

  try {
    await ctx.sendChatAction("typing");

    const answer = await askGroq(
      text,
      displayName(ctx.from),
      ctx.chat.id,
      ctx.from.id
    );

    await reply(ctx, answer);
  } catch (error) {
    safeError(error);

    if (error.message === "AI_DISABLED") {
      return reply(ctx, "الذكاء الاصطناعي متوقف حاليا.");
    }

    await reply(
      ctx,
      "حصلت مشكلة بسيطة أثناء تجهيز الإجابة. حاول مرة تانية بعد قليل."
    );
  }
});

// =====================================================
// الترحيب بالأعضاء الجدد
// =====================================================

bot.on("new_chat_members", async ctx => {
  for (const user of ctx.message.new_chat_members) {
    if (user.id === botId) {
      await reply(
        ctx,
        `أهلا بيكم. أنا ${BOT_NAME}، جاهزة أساعدكم في الأسئلة والألعاب وإدارة المجموعة.`
      );

      continue;
    }

    registerPlayer(ctx.chat.id, user);

    await reply(
      ctx,
      `أهلا وسهلا ${displayName(user)}.\n` +
      "نورت المجموعة. أتمنى لك وقتا جميلا معنا."
    );
  }
});

// =====================================================
// تنظيف الجولات والعدادات القديمة
// =====================================================

const cleanupTimer = setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    if (
      session.expiresAt < now ||
      session.answered
    ) {
      sessions.delete(id);
    }
  }

  for (const [key, time] of cooldowns.entries()) {
    if (now - time > 120000) {
      cooldowns.delete(key);
    }
  }
}, 60000);

cleanupTimer.unref();

// =====================================================
// خادم الصحة لـ Render
// =====================================================

const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    return res.end(JSON.stringify({
      status: "ok",
      bot: BOT_NAME,
      model: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
      ai_enabled: AI_ENABLED,
      time: new Date().toISOString()
    }));
  }

  res.writeHead(404, {
    "Content-Type": "application/json; charset=utf-8"
  });

  res.end(JSON.stringify({
    status: "not_found"
  }));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Malak AI health server listening on ${PORT}`);
});

// =====================================================
// تشغيل البوت
// =====================================================

bot.catch((error, ctx) => {
  console.error(
    `Telegram update error ${ctx.update?.update_id || ""}:`,
    error?.description || error?.message || error
  );
});

async function main() {
  try {
    const me = await bot.telegram.getMe();

    botId = me.id;

    await bot.telegram.setMyCommands([
      { command: "start", description: "بدء الاستخدام" },
      { command: "help", description: "المساعدة" },
      { command: "games", description: "مركز الألعاب" },
      { command: "quiz", description: "مسابقة معلومات عامة" },
      { command: "riddle", description: "فزورة جديدة" },
      { command: "math", description: "تحدي الحساب" },
      { command: "guess", description: "خمن الرقم" },
      { command: "points", description: "رصيدك" },
      { command: "daily", description: "المكافأة اليومية" },
      { command: "top", description: "المتصدرون" },
      { command: "id", description: "معرفة المعرفات" },
      { command: "resetai", description: "مسح سياق المحادثة" },
      { command: "lock", description: "قفل المجموعة للمشرفين" },
      { command: "unlock", description: "فتح المجموعة للمشرفين" },
      { command: "kick", description: "طرد عضو بالرد على رسالته" },
      { command: "delete", description: "حذف رسالة بالرد عليها" }
    ]);

    console.log("----------------------------------");
    console.log(`${BOT_NAME} is starting`);
    console.log(`Bot: ${me.first_name}`);
    console.log(`Username: @${me.username}`);
    console.log(`Model: ${process.env.GROQ_MODEL || "openai/gpt-oss-120b"}`);
    console.log(`AI enabled: ${AI_ENABLED && Boolean(process.env.GROQ_API_KEY)}`);
    console.log("----------------------------------");

    await bot.launch({
      allowedUpdates: [
        "message",
        "callback_query",
        "my_chat_member"
      ]
    });

    console.log(`${BOT_NAME} is running successfully.`);
  } catch (error) {
    safeError(error);
    process.exitCode = 1;
  }
}

// =====================================================
// إيقاف آمن
// =====================================================

async function shutdown(signal) {
  if (shuttingDown) return;

  shuttingDown = true;

  console.log(`Shutting down (${signal})...`);

  clearInterval(cleanupTimer);

  try {
    bot.stop(signal);
  } catch {}

  server.close();

  try {
    closeDatabase();
  } catch (error) {
    safeError(error);
  }
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

main();