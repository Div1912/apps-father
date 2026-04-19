// EN/RU localization + Telegram deep-link rewriting for the landing page.
// - Default language: EN. `?lang=ru` (or `?lang=en`) overrides; choice persists.
// - All <a href="https://t.me/apps_father_bot/app"> links get a `startapp` param.
//   Default value is "landing". When the page is opened with `?startapp=foo`,
//   that value is forwarded into every Telegram link instead.
(function () {
  var TR = {
    en: {
      "doc.title": "Apps Father — Build Telegram Mini Apps with AI",

      "nav.how": "How it works",
      "nav.examples": "Examples",
      "nav.features": "Features",
      "nav.cta": "✈ Start free",
      "nav.lang": "RU",

      "hero.badge": "AI · No code · Live in 2 min",
      "hero.h1.a": "Type an idea.",
      "hero.h1.b": "Get an app.",
      "hero.p": "Describe what you want in plain text. Apps Father AI builds a full Telegram Mini App in minutes — payments, backend, UI, everything.",
      "hero.btn.main": "Build my app free",
      "hero.btn.ghost": "See examples ↓",
      "hero.social": "Joined by <strong>2,400+</strong> builders already",

      "deco.1": "⚡ Built in 2 min",
      "deco.2": "💎 TON Payments",
      "deco.3": "🚀 Live instantly",
      "deco.float": "⚡ AI is building right now",

      "chat.name": "Apps Father AI",
      "chat.online": "online",
      "chat.greet": "Hey! Tell me what Telegram app you want to build. 🚀",
      "chat.placeholder": "Describe your app idea...",

      "herochat.btn": "Try it now — free",
      "herochat.sub": "No code · No credit card · Live in 2 min",

      "how.tag": "How it works",
      "how.h": "THREE STEPS.<br>ONE MESSAGE.",
      "how.p": "No IDE. No Stack Overflow. Just describe your idea like you'd brief a developer.",
      "step.1.h": "Describe your idea",
      "step.1.p": "Message @apps_father_bot in plain English. \"Build a crypto game with TON payments and a jackpot wheel\" — that's it.",
      "step.2.h": "AI builds it",
      "step.2.p": "Full Mini App in minutes — UI, logic, backend, TON & Stars. Production-ready, not a mockup.",
      "step.3.h": "Publish & iterate",
      "step.3.p": "Live in one tap. Update anytime with another message. No developers, no delays.",
      "stats.1": "Builders worldwide",
      "stats.2": "Average build time",
      "stats.3": "No code required",

      "apps.tag": "Built with Apps Father",
      "apps.h": "REAL APPS.<br>REAL USERS.",
      "apps.p": "Every single one was generated from a text message. No developers involved.",

      "clash.tag": "PvP Betting Game",
      "clash.h": "Clash Arena",
      "clash.p": "Live multiplayer arena — players stake DJM tokens, jackpot drum picks the winner. TON & Stars payments, wheel of fortune, seasonal leaderboard, push notifications.",
      "clash.c1": "TON Payments",
      "clash.c2": "Jackpot Drum",
      "clash.c3": "Real-time PvP",
      "clash.c4": "Leaderboard",
      "clash.c5": "Push Notifications",

      "mine.tag": "Multiplayer Game",
      "mine.h": "Minegram",
      "mine.p": "Full Minecraft-style game inside Telegram. Mine, craft, trade on the market, climb daily leaderboards — real TON economy with 50+ items.",
      "mine.c1": "Crafting System",
      "mine.c2": "TON Economy",
      "mine.c3": "Item Market",
      "mine.c4": "Daily Leaderboard",

      "imusic.tag": "Music Player",
      "imusic.h": "iMusic",
      "imusic.p": "A native-feeling music player inside Telegram. Browse playlists, queue tracks, and stream from your library — all wrapped in a smooth iOS-style interface.",
      "imusic.c1": "Native UI",
      "imusic.c2": "Playlists",
      "imusic.c3": "Background Audio",
      "imusic.c4": "Smart Queue",

      "anon.tag": "Social + Fintech",
      "anon.h": "AnonChat &<br>TON Wallet",
      "anon.p": "Anonymous matching and real-time chat by interests. Plus a self-custodial TON Wallet with Stars ↔ TON conversion. Two apps — both from one message each.",
      "anon.c1": "Anonymous Chat",
      "anon.c2": "Quick Match",
      "anon.c3": "TON Blockchain",
      "anon.c4": "Stars Conversion",

      "swipe.tag": "Crypto Discovery",
      "swipe.h": "Swipe",
      "swipe.p": "Tinder-style discovery for crypto. Swipe through trending tokens, save your favourites, and act on signals — a fast, opinionated way to scout the market.",
      "swipe.c1": "Token Cards",
      "swipe.c2": "Live Prices",
      "swipe.c3": "Watchlist",
      "swipe.c4": "Signals",

      "feat.tag": "Why Apps Father",
      "feat.h": "NOT A TEMPLATE.<br>YOUR APP.",
      "feat.1.h": "Just describe what you want",
      "feat.1.p": "No forms. No drag-and-drop. Brief it like a senior developer. Apps Father understands PvP mechanics, TON payments, leaderboards — and ships the whole thing.",
      "feat.2.h": "TON & Stars built in",
      "feat.2.p": "Every app ships with Telegram Stars and TON blockchain support. Monetize from day one — zero configuration.",
      "feat.3.h": "Update in one message",
      "feat.3.p": "\"Add a daily spin wheel\" — done in minutes. Iterate as fast as you type. No PRs, no staging, no waiting.",
      "feat.4.h": "Any category",
      "feat.4.p": "Games, social, fintech, tools, crypto, e-commerce. If it runs inside Telegram, Apps Father builds it.",
      "feat.5.h": "Full ownership",
      "feat.5.p": "Your bot, your domain. Export full codebase anytime. Apps Father builds — you own everything.",

      "testi.tag": "What builders say",
      "testi.h": "SHIPPED IN<br>MINUTES.",
      "testi.1.q": "\"I described my idea at 11pm. By midnight I had a <strong>working crypto betting game with TON payments</strong>. Genuinely insane.\"",
      "testi.1.role": "Indie builder · Clash Arena",
      "testi.2.q": "\"Built a full Minecraft game with crafting, market and leaderboard. <strong>Zero code written by me.</strong> Apps Father handled everything.\"",
      "testi.2.role": "Game developer · Telegram Miner",
      "testi.3.q": "\"From idea to live app in <strong>under 3 minutes.</strong> Updated it 6 times that day just by texting. This is the future.\"",
      "testi.3.role": "Entrepreneur · AnonChat",

      "final.h.a": "YOUR IDEA IS",
      "final.h.b": "ONE MESSAGE AWAY.",
      "final.p": "Join 2,400+ builders who ship Telegram apps in minutes, not months.",
      "final.btn": "Open Apps Father Free",
      "final.n1": "No credit card",
      "final.n2": "No code required",
      "final.n3": "Live in 2 minutes",

      "footer.tag": "Built with AI · Powered by Telegram",

      "cp.greet": "Hey! 👋 Describe the Telegram app you want to build — I'll generate it right now.",
      "cp.ex.1": "🎰 Betting game",
      "cp.ex.2": "💬 Anon chat",
      "cp.ex.3": "⛏ Mining game",
      "cp.ex.4": "📈 Trading app",
      "cp.placeholder": "Describe your app idea..."
    },

    ru: {
      "doc.title": "Apps Father — создавайте Telegram Mini Apps с ИИ",

      "nav.how": "Как это работает",
      "nav.examples": "Примеры",
      "nav.features": "Возможности",
      "nav.cta": "✈ Начать бесплатно",
      "nav.lang": "EN",

      "hero.badge": "ИИ · Без кода · Запуск за 2 минуты",
      "hero.h1.a": "Опишите идею,",
      "hero.h1.b": "запустите бизнес",
      "hero.p": "Опишите, что вы хотите, обычным текстом. Apps Father AI соберёт полноценный Telegram Mini App за минуты — оплаты, бэкенд, интерфейс, всё сразу.",
      "hero.btn.main": "Создать приложение бесплатно",
      "hero.btn.ghost": "Смотреть примеры ↓",
      "hero.social": "Уже с нами <strong>2 400+</strong> создателей",

      "deco.1": "⚡ Готово за 2 минуты",
      "deco.2": "💎 Оплата TON",
      "deco.3": "🚀 Запуск мгновенно",
      "deco.float": "⚡ ИИ строит прямо сейчас",

      "chat.name": "Apps Father AI",
      "chat.online": "в сети",
      "chat.greet": "Привет! Расскажите, какое Telegram-приложение хотите создать. 🚀",
      "chat.placeholder": "Опишите идею приложения...",

      "herochat.btn": "Попробовать сейчас — бесплатно",
      "herochat.sub": "Без кода · Без карты · Запуск за 2 минуты",

      "how.tag": "Как это работает",
      "how.h": "ТРИ ШАГА.<br>ОДНО СООБЩЕНИЕ.",
      "how.p": "Без IDE. Без Stack Overflow. Просто опишите идею так, как объяснили бы разработчику.",
      "step.1.h": "Опишите идею",
      "step.1.p": "Напишите @apps_father_bot обычным языком. «Сделай крипто-игру с оплатой в TON и колесом джекпота» — и всё.",
      "step.2.h": "ИИ собирает",
      "step.2.p": "Полноценный Mini App за минуты — UI, логика, бэкенд, TON и Stars. Готов к продакшену, не макет.",
      "step.3.h": "Публикуйте и улучшайте",
      "step.3.p": "Запуск в один тап. Меняйте в любой момент новым сообщением. Без разработчиков и задержек.",
      "stats.1": "Создателей по всему миру",
      "stats.2": "Среднее время сборки",
      "stats.3": "Кода не требуется",

      "apps.tag": "Сделано в Apps Father",
      "apps.h": "РЕАЛЬНЫЕ ПРИЛОЖЕНИЯ.<br>РЕАЛЬНЫЕ ЛЮДИ.",
      "apps.p": "Каждое — из одного текстового сообщения. Без разработчиков.",

      "clash.tag": "PvP-игра на ставки",
      "clash.h": "Clash Arena",
      "clash.p": "Живая мультиплеерная арена — игроки ставят токены DJM, барабан джекпота выбирает победителя. Оплата TON и Stars, колесо фортуны, сезонный рейтинг, push-уведомления.",
      "clash.c1": "Оплата TON",
      "clash.c2": "Барабан джекпота",
      "clash.c3": "PvP в реальном времени",
      "clash.c4": "Рейтинг",
      "clash.c5": "Push-уведомления",

      "mine.tag": "Мультиплеер",
      "mine.h": "Minegram",
      "mine.p": "Полноценная Minecraft-игра в Telegram. Добывайте, крафтите, торгуйте на рынке, поднимайтесь в дневном рейтинге — реальная TON-экономика и 50+ предметов.",
      "mine.c1": "Система крафта",
      "mine.c2": "Экономика TON",
      "mine.c3": "Рынок предметов",
      "mine.c4": "Дневной рейтинг",

      "imusic.tag": "Музыкальный плеер",
      "imusic.h": "iMusic",
      "imusic.p": "Нативный музыкальный плеер прямо в Telegram. Листайте плейлисты, ставьте треки в очередь и слушайте свою библиотеку — всё в гладком интерфейсе в стиле iOS.",
      "imusic.c1": "Нативный UI",
      "imusic.c2": "Плейлисты",
      "imusic.c3": "Фоновое воспроизведение",
      "imusic.c4": "Умная очередь",

      "anon.tag": "Социальное + финтех",
      "anon.h": "AnonChat и<br>TON-кошелёк",
      "anon.p": "Анонимный мэтчинг и чат в реальном времени по интересам. Плюс некастодиальный TON-кошелёк с обменом Stars ↔ TON. Два приложения — каждое из одного сообщения.",
      "anon.c1": "Анонимный чат",
      "anon.c2": "Быстрый мэтчинг",
      "anon.c3": "Блокчейн TON",
      "anon.c4": "Конвертация Stars",

      "swipe.tag": "Крипто-открытия",
      "swipe.h": "Swipe",
      "swipe.p": "Tinder-стиль для крипты. Свайпайте трендовые токены, сохраняйте избранное и реагируйте на сигналы — быстрый и точный способ изучать рынок.",
      "swipe.c1": "Карточки токенов",
      "swipe.c2": "Цены в реальном времени",
      "swipe.c3": "Избранное",
      "swipe.c4": "Сигналы",

      "feat.tag": "Почему Apps Father",
      "feat.h": "Скорость и качество",
      "feat.1.h": "Просто опишите, что вам нужно",
      "feat.1.p": "Без форм. Без drag-and-drop. Объясните как сеньору. Apps Father понимает PvP-механики, оплаты в TON, рейтинги — и собирает всё целиком.",
      "feat.2.h": "TON и Stars из коробки",
      "feat.2.p": "Каждое приложение поддерживает Telegram Stars и блокчейн TON. Монетизация с первого дня — без настройки.",
      "feat.3.h": "Обновления одним сообщением",
      "feat.3.p": "«Добавь ежедневное колесо удачи» — готово за минуты. Итерируйте со скоростью набора текста. Без PR, staging и ожиданий.",
      "feat.4.h": "Любая категория",
      "feat.4.p": "Игры, соцсети, финтех, инструменты, крипта, e-commerce. Если работает в Telegram — Apps Father это соберёт.",
      "feat.5.h": "Полное владение",
      "feat.5.p": "Ваш бот, ваш домен. В любой момент выгружайте полный код. Apps Father создаёт — вы владеете всем.",

      "testi.tag": "Что говорят создатели",
      "testi.h": "ЗАПУСТИЛИ<br>ЗА МИНУТЫ.",
      "testi.1.q": "«Описал идею в 23:00. К полуночи у меня была <strong>работающая крипто-игра с оплатой TON</strong>. Просто безумие.»",
      "testi.1.role": "Инди-разработчик · Clash Arena",
      "testi.2.q": "«Собрал полноценную Minecraft-игру с крафтом, рынком и рейтингом. <strong>Я не написал ни строчки кода.</strong> Apps Father сделал всё сам.»",
      "testi.2.role": "Геймдев · Telegram Miner",
      "testi.3.q": "«От идеи до живого приложения <strong>меньше чем за 3 минуты.</strong> В тот же день обновил его 6 раз — просто сообщениями. Это будущее.»",
      "testi.3.role": "Предприниматель · AnonChat",

      "final.h.a": "ВАШ БИЗНЕС —",
      "final.h.b": "ЗАПУСТИТСЯ СЕГОДНЯ.",
      "final.p": "Присоединяйтесь к 2 400+ создателям, которые запускают Telegram-приложения за минуты, а не месяцы.",
      "final.btn": "Открыть Apps Father бесплатно",
      "final.n1": "Без банковской карты",
      "final.n2": "Без кода",
      "final.n3": "Запуск за 2 минуты",

      "footer.tag": "Сделано с ИИ · Работает на Telegram",

      "cp.greet": "Привет! 👋 Опишите Telegram-приложение, которое хотите создать — я сгенерирую его прямо сейчас.",
      "cp.ex.1": "🎰 Игра на ставки",
      "cp.ex.2": "💬 Анонимный чат",
      "cp.ex.3": "⛏ Майнинг-игра",
      "cp.ex.4": "📈 Трейдинговое приложение",
      "cp.placeholder": "Опишите идею приложения..."
    }
  };

  function detectLang() {
    var p = new URLSearchParams(location.search);
    var q = (p.get("lang") || "").toLowerCase();
    if (q === "ru") return "ru";
    if (q === "en") return "en";
    try {
      var saved = localStorage.getItem("af_lang");
      if (saved === "ru" || saved === "en") return saved;
    } catch (e) {}
    return "en";
  }

  function getStartApp() {
    var p = new URLSearchParams(location.search);
    var s = (p.get("startapp") || "").trim();
    return s || "landing";
  }

  function applyTranslations(lang) {
    var dict = TR[lang] || TR.en;

    var titleKey = dict["doc.title"];
    if (titleKey) document.title = titleKey;

    document.querySelectorAll("[data-i18n]").forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] != null) el.innerHTML = dict[key];
    });

    // Format: "attr:key,attr:key" — e.g. "placeholder:chat.placeholder"
    document.querySelectorAll("[data-i18n-attr]").forEach(function (el) {
      var spec = el.getAttribute("data-i18n-attr");
      spec.split(",").forEach(function (pair) {
        var parts = pair.split(":");
        if (parts.length === 2 && dict[parts[1]] != null) {
          el.setAttribute(parts[0].trim(), dict[parts[1].trim()]);
        }
      });
    });

    document.documentElement.setAttribute("lang", lang);
  }

  function applyStartApp() {
    var sa = getStartApp();
    var sels = 'a[href*="t.me/apps_father_bot/app"]';
    document.querySelectorAll(sels).forEach(function (a) {
      try {
        var u = new URL(a.href);
        u.searchParams.set("startapp", sa);
        a.href = u.toString();
      } catch (e) {
        // Fallback for relative or malformed URLs.
        var href = a.getAttribute("href") || "";
        if (href.indexOf("t.me/apps_father_bot/app") !== -1) {
          var sep = href.indexOf("?") === -1 ? "?" : "&";
          a.setAttribute(
            "href",
            href.replace(/([?&])startapp=[^&]*/, "$1") +
              (href.indexOf("startapp=") === -1 ? sep + "startapp=" + encodeURIComponent(sa) : "")
          );
        }
      }
    });
  }

  function setLang(lang) {
    try { localStorage.setItem("af_lang", lang); } catch (e) {}
    applyTranslations(lang);
  }

  // Click delegation — fire Google Ads conversion when the user opens any
  // Telegram bot link, then navigate via the gtag event_callback so the
  // conversion ping is actually delivered before the browser unloads.
  function wireConversionTracking() {
    document.addEventListener("click", function (e) {
      // Honor middle-click / ctrl+click / cmd+click / shift+click — let those
      // open in a new tab without blocking; we still fire the conversion.
      var anchor = e.target && e.target.closest ? e.target.closest("a") : null;
      if (!anchor) return;
      var href = anchor.href || "";
      if (href.indexOf("t.me/apps_father_bot/app") === -1) return;

      // If gtag isn't loaded for any reason, do nothing special — let the
      // browser navigate normally so the user always reaches Telegram.
      if (typeof window.gtag_report_conversion !== "function") return;

      var newTab =
        e.button === 1 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        anchor.target === "_blank";

      if (newTab) {
        // Fire-and-forget: report the conversion but don't intercept navigation.
        try { window.gtag_report_conversion(); } catch (_) {}
        return;
      }

      // Same-tab navigation: let gtag_report_conversion handle window.location
      // after the event_callback fires.
      e.preventDefault();
      try { window.gtag_report_conversion(href); } catch (_) { window.location = href; }

      // Safety net: if gtag never calls back (ad-blocker, network), navigate
      // anyway after a short timeout so the user is never stranded.
      setTimeout(function () {
        if (window.location.href.indexOf("t.me/apps_father_bot/app") === -1) {
          window.location = href;
        }
      }, 1200);
    }, true);
  }

  function init() {
    var lang = detectLang();
    applyTranslations(lang);
    applyStartApp();
    wireConversionTracking();

    var toggle = document.getElementById("langToggle");
    if (toggle) {
      toggle.addEventListener("click", function (e) {
        e.preventDefault();
        var cur = document.documentElement.getAttribute("lang") || "en";
        setLang(cur === "ru" ? "en" : "ru");
      });
    }

    // Watch for dynamically injected Telegram links (e.g. chat demo success
    // bubbles) and rewrite their hrefs as soon as they appear.
    if (typeof MutationObserver !== "undefined") {
      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          if (muts[i].addedNodes && muts[i].addedNodes.length) {
            applyStartApp();
            return;
          }
        }
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Expose for debugging / re-application from app.js if needed.
  window.AFLang = { setLang: setLang, applyStartApp: applyStartApp };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
