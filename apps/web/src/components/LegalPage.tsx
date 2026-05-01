"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ArrowRight, Check, Loader2, Paperclip, X } from "lucide-react";
import { CaptchaWidget } from "@/components/CaptchaWidget";

type LegalKey = "terms" | "privacy" | "cookies" | "upload" | "copyright";

// При публичном запуске:
//  1. Заменить заглушки «Ф.И.О.» и «000000000000» на реальные данные оператора.
//  2. Подать в Роскомнадзор уведомление об обработке ПДн и о трансграничной
//     передаче (только после подачи фразы в privacy п.7 про подачу РКН
//     перестают быть декларативными).
//  3. Версия редакции и тексты галок/баннеров — в `lib/legalDocumentVersions.ts`,
//     там же пересчитываются hash'и при логировании в `LegalConsent`.

const LEGAL_DOCS: Record<LegalKey, {
  title: string;
  eyebrow: string;
  updated: string;
  intro: string;
  sections: Array<{ h: string; b: string }> | null;
}> = {
  terms: {
    title: "Пользовательское соглашение",
    eyebrow: "Оферта",
    updated: "Редакция от 1 мая 2026",
    intro: "Это публичная оферта — правила, на которых ремарка оказывает вам услуги. Регистрируясь или продолжая пользоваться сервисом, вы соглашаетесь с этими условиями. Документ заключается в электронной форме и имеет силу письменного договора.",
    sections: [
      { h: "1. Кто оказывает услуги", b: "Услуги оказывает Самозанятый «Ф.И.О.», ИНН «000000000000», плательщик налога на профессиональный доход (далее — Исполнитель). Связь: hello@remarka.app." },
      { h: "2. Что такое ремарка", b: "ремарка — онлайн-сервис анализа литературных текстов. Загруженный вами файл обрабатывается алгоритмически: формируется разбор (саммари, ключевые идеи, персонажи, события) и ответы ассистента на ваши вопросы. Результат доступен только вам внутри вашей учётной записи. Сервис не является публичной библиотекой, не публикует загруженные файлы и не передаёт их другим пользователям." },
      { h: "3. Возрастное ограничение", b: "Сервис предназначен для пользователей, достигших 18 лет. Подтверждая согласие при регистрации, вы заявляете, что достигли этого возраста. Если Исполнителю станет известно, что учётная запись принадлежит несовершеннолетнему, она будет удалена; при наличии оплаченной подписки — оплаченные суммы возвращаются за вычетом фактически понесённых Исполнителем расходов на приём и возврат платежа. Законные представители несовершеннолетнего могут направить запрос на удаление учётной записи и связанных данных по адресу privacy@remarka.app." },
      { h: "4. Учётная запись", b: "Для доступа к приватным функциям (библиотека, загрузка, чат) нужна учётная запись. Вход выполняется через Яндекс ID. Вы отвечаете за конфиденциальность доступа к своему Яндекс-аккаунту. Вы можете удалить учётную запись и все связанные с ней данные через профиль в любой момент." },
      { h: "5. Загрузка ваших файлов", b: "Регулируется отдельным документом «Условия загрузки произведения». Перед загрузкой вы подтверждаете, что у вас есть законное основание загрузить файл, и предоставляете Исполнителю ограниченную лицензию на хранение, индексацию и анализ файла исключительно для выдачи результата вам." },
      { h: "6. Допустимое использование", b: "Запрещено использовать сервис для систематического восстановления полного текста загруженных или иных книг, для создания публичной библиотеки, для распространения контента третьим лицам или для обхода технических средств защиты прав. Исполнитель применяет технические ограничения на длину одновременно выдаваемых фрагментов; попытки обойти их являются нарушением соглашения." },
      { h: "7. Тарифы и порядок оплаты", b: "Стоимость услуг указана на странице «Тарифы». Оплата принимается через сервис ЮKassa, банковскими картами физических лиц. Доступ к платным функциям предоставляется после поступления средств. После оплаты вы получаете чек налога на профессиональный доход, сформированный в сервисе ФНС «Мой налог», по электронной почте или ссылкой в личном кабинете. Услуга в чеке именуется как «Доступ к онлайн-сервису анализа текста, тариф [название], период [N дней]» — без упоминания книги или произведения." },
      { h: "8. Отмена и возврат средств", b: "Вы можете в любой момент отказаться от договора. Если доступ к сервису не был предоставлен по причинам на стороне Исполнителя — оплаченная сумма возвращается полностью. Если доступ был предоставлен и частично использован — возврат рассчитывается пропорционально неиспользованному периоду подписки. С возвращаемой суммы могут удерживаться комиссии платёжного провайдера, фактически понесённые Исполнителем при приёме и возврате платежа. Возврат осуществляется на основании ст. 32 Закона РФ «О защите прав потребителей». Заявление направляется на hello@remarka.app, рассматривается в срок не более 10 рабочих дней." },
      { h: "9. Автопродление", b: "На текущем этапе автоматическое продление подписок не используется — каждый период оплачивается вами явно. Если автопродление будет введено, об этом будет дополнительно уведомлено по e-mail и в интерфейсе не менее чем за 14 дней; вы сможете отключить его в профиле в любой момент." },
      { h: "10. Доступность сервиса", b: "Исполнитель стремится к стабильной работе, но не гарантирует непрерывной доступности. Плановые обслуживания, сбои инфраструктуры, недоступность сторонних сервисов (включая поставщиков AI-моделей) и обстоятельства непреодолимой силы могут приводить к временной недоступности отдельных функций. Гарантированный SLA для тарифов начального уровня не предоставляется. При длительной недоступности оплаченных функций по причинам на стороне Исполнителя или его подрядчиков период подписки продлевается на срок недоступности либо, по выбору пользователя, оплата возвращается пропорционально." },
      { h: "11. Ограничение ответственности", b: "Ответы ассистента формируются автоматически с использованием технологий искусственного интеллекта (LLM) и могут содержать ошибки, неточности и галлюцинации. Сервис не предоставляет юридических, медицинских, финансовых, психологических или иных профессиональных консультаций. Исполнитель не несёт ответственности за решения, принятые пользователем на основании ответов ассистента, и за косвенные убытки. При обнаружении неточности в ответе ассистента вы можете сообщить об этом через интерфейс — это поможет улучшить сервис, но не создаёт обязанности Исполнителя по компенсации. Ответственность Исполнителя в любом случае ограничена суммой, фактически уплаченной вами за период, в котором произошло событие." },
      { h: "12. Изменения условий", b: "Редакция соглашения может меняться. Существенные изменения мы анонсируем в интерфейсе и по e-mail не менее чем за 14 дней до вступления в силу. Продолжая пользоваться сервисом после этой даты, вы принимаете новую редакцию." },
      { h: "13. Юридически значимые уведомления", b: "Направляйте на hello@remarka.app. Заявления правообладателей — на abuse@remarka.app или через форму на странице «Жалоба правообладателя». Ответ направляется с тех же адресов; электронная переписка имеет силу письменной." },
      { h: "14. Применимое право и подсудность", b: "К отношениям применяется право Российской Федерации. Споры рассматриваются в порядке, установленном законодательством Российской Федерации о защите прав потребителей. В соответствии со ст. 17 Закона РФ «О защите прав потребителей» пользователь вправе по своему выбору обратиться в суд по своему месту жительства или пребывания, либо по месту нахождения Исполнителя." },
    ],
  },
  privacy: {
    title: "Политика обработки персональных данных",
    eyebrow: "Обязательный документ",
    updated: "Редакция от 1 мая 2026",
    intro: "Документ описывает, какие персональные данные обрабатываются, на каких основаниях и как вы можете этим управлять. Политика публикуется в открытом доступе, как того требует Федеральный закон от 27.07.2006 № 152-ФЗ «О персональных данных».",
    sections: [
      { h: "1. Оператор", b: "Самозанятый «Ф.И.О.», ИНН «000000000000», плательщик налога на профессиональный доход. Связь: hello@remarka.app. По вопросам обработки персональных данных: privacy@remarka.app." },
      { h: "2. Какие данные обрабатываются", b: "Идентификационные данные при регистрации через Яндекс ID (имя, e-mail, аватар, идентификатор Яндекс-аккаунта), cookies сессии, история ваших чатов с ассистентом, загруженные вами файлы и результаты их анализа, технические данные (IP-адрес, тип устройства, браузер, поведенческие сигналы при прохождении защиты от ботов), платёжные идентификаторы при оплате через ЮKassa. Содержимое загруженных файлов формально не относится к персональным данным, но мы относимся к нему как к информации с повышенным режимом защиты." },
      { h: "3. Цели обработки", b: "Создание и ведение учётной записи; оказание услуги анализа текста; ведение истории диалогов с ассистентом; рассмотрение обращений и платежей; защита от злоупотреблений и обеспечение работоспособности сервиса; исполнение требований закона." },
      { h: "4. Правовые основания", b: "Для базовой работы сервиса — исполнение договора (Пользовательского соглашения), который заключается с вами при регистрации. Для аналитики и персонализации — ваше согласие, которое вы можете отозвать через настройки cookie-файлов. Для трансграничной передачи отдельных категорий данных (см. п.7) — ваше явное согласие, которое вы даёте при регистрации. Для ответа на запросы государственных органов — исполнение требований закона." },
      { h: "5. Где хранятся данные", b: "Основная база данных, файлы и результаты анализа размещены на серверах в Российской Федерации. Это соответствует требованию ч. 5 ст. 18 закона № 152-ФЗ о локализации первичного хранения персональных данных граждан Российской Федерации." },
      { h: "6. Передача третьим лицам", b: "Для оказания услуги мы привлекаем следующих обработчиков: (а) ООО «Яндекс» (Российская Федерация) — авторизация через Яндекс ID; при входе получаются имя, e-mail и идентификатор аккаунта; (б) ООО «Яндекс» (Российская Федерация) — защита от ботов через сервис Yandex SmartCaptcha; обрабатываются IP-адрес, технические идентификаторы устройства и поведенческие сигналы при прохождении проверки; (в) Google LLC (США) через Google Vertex AI — отправка содержимого вашего запроса, истории чата и фрагментов вашего файла для генерации ответа AI-ассистентом и для построения векторных представлений (эмбеддингов) текста; передача осуществляется в псевдонимизированном виде: ваши идентификационные данные (имя, e-mail, идентификатор Яндекс-аккаунта) не передаются; согласно действующим на дату публикации настоящей Политики условиям Google Cloud Service Terms, передаваемые данные не используются Google для обучения публичных моделей; возможна автоматическая проверка контента на злоупотребления, при которой подозрительные запросы могут логироваться сроком до 90 дней; Исполнитель отслеживает изменения этих условий и в случае их существенного изменения уведомит пользователей; (г) ООО НКО «ЮMoney» (Российская Федерация) — приём платежей через сервис ЮKassa; (д) поставщики хостинга и инфраструктурных услуг на территории Российской Федерации — размещение базы данных, файлового хранилища и вычислительных мощностей для обработки данных в РФ (включая локальное переранжирование результатов поиска). Данные передаются только в объёме, необходимом для оказания услуги." },
      { h: "7. Трансграничная передача персональных данных", b: "При использовании Google Vertex AI часть данных передаётся за пределы Российской Федерации, в США. Передаются только содержимое запросов пользователя, история текущего чата и фрагменты загруженных файлов — без идентификаторов пользователя, имени, e-mail и иных прямых идентификационных признаков. США не входят в перечень государств, обеспечивающих адекватную защиту прав субъектов персональных данных, утверждённый Роскомнадзором. Передача осуществляется с вашего явного согласия, которое вы даёте при регистрации в сервисе. Уведомление о трансграничной передаче подано в Роскомнадзор в порядке ч. 3 ст. 12 закона № 152-ФЗ. Иные потоки данных (авторизация, защита от ботов, хостинг, обработка платежей, локальное переранжирование результатов) обрабатываются на территории Российской Федерации и трансграничной передачи не предполагают." },
      { h: "8. Использование данных для обучения моделей", b: "Мы не используем содержимое ваших файлов и историю ваших чатов для обучения, дообучения или тонкой настройки моделей машинного обучения. По данным наших обработчиков (см. п.6), переданные им данные также не используются для обучения публичных моделей." },
      { h: "9. Срок хранения", b: "Данные учётной записи удаляются из активных систем в течение 7 дней после её удаления пользователем; в резервных копиях хранятся до 60 дней, после чего удаляются по графику ротации. Логи авторизации — до 1 года. Платёжные документы — в течение сроков, установленных налоговым законодательством. Файлы и результаты анализа — пока книга находится в вашей библиотеке; после удаления книги — до 7 дней в активных хранилищах и до 60 дней в резервных копиях." },
      { h: "10. Ваши права", b: "Вы можете запросить доступ к своим персональным данным, их исправление или удаление, ограничить обработку, отозвать согласие, получить копию данных. Запрос направляйте на privacy@remarka.app — ответ предоставляется в срок не более 10 рабочих дней (ст. 20 закона № 152-ФЗ). Удалить учётную запись и все связанные данные можно самостоятельно через профиль; выгрузить копию основных данных — через функцию «Выгрузить мои данные» в профиле." },
      { h: "11. Безопасность", b: "Применяются технические и организационные меры защиты: шифрование при передаче (TLS) и в покое, разграничение доступа, журналирование действий администраторов." },
      { h: "12. Возрастные ограничения", b: "Сервис предназначен для лиц старше 18 лет и не рассчитан на несовершеннолетних. Если вы — законный представитель несовершеннолетнего и обнаружили, что ребёнок зарегистрировался самостоятельно, направьте запрос на privacy@remarka.app — учётная запись и связанные данные будут удалены." },
      { h: "13. Изменения политики", b: "Редакция может обновляться. Дата последней редакции указана вверху документа. Существенные изменения анонсируются в интерфейсе и по e-mail." },
    ],
  },
  cookies: {
    title: "Использование cookie-файлов",
    eyebrow: "Техническое описание",
    updated: "Редакция от 1 мая 2026",
    intro: "Cookie-файлы — это небольшие файлы, которые браузер сохраняет при посещении сайта. Мы используем их минимально и прозрачно. Ниже — полный перечень с назначением.",
    sections: [
      { h: "Оператор cookie-файлов", b: "Самозанятый «Ф.И.О.», ИНН «000000000000». Контакт по вопросам обработки данных: privacy@remarka.app." },
      { h: "Необходимые", b: "Обеспечивают вход и сессию, защиту от CSRF, сохранение выбранной темы, работу защиты от ботов. Без них сервис не работает. Хранятся: до закрытия браузера или 30 дней (refresh-токен)." },
      { h: "Аналитические", b: "Помогают понять, какими разделами пользуются чаще. Данные обезличены. Включаются только с вашего согласия — через баннер или раздел «Настройки cookie-файлов» в профиле. Хранятся: до 12 месяцев." },
      { h: "Персонализация", b: "Запоминают недавние чаты, предпочтения каталога, язык. Включаются по согласию. Хранятся: до 12 месяцев." },
      { h: "Метрические программы", b: "Мы не используем Яндекс.Метрику или Google Analytics без вашего явного согласия." },
      { h: "Управление", b: "Вы можете изменить настройки в любой момент: в футере любой страницы → «Cookie-файлы» → «Настроить». Можно также отключить cookie-файлы в браузере — но тогда перестанут работать авторизация и часть функций." },
    ],
  },
  upload: {
    title: "Условия загрузки произведения",
    eyebrow: "Лицензия на внутреннее использование",
    updated: "Редакция от 1 мая 2026",
    intro: "Этот документ — отдельный от Пользовательского соглашения. Он регулирует только одно: что происходит, когда вы загружаете в ремарку свой файл. Перед загрузкой вы подтверждаете согласие с этим документом одной галкой.",
    sections: [
      { h: "1. Законное основание загрузки", b: "Загружая файл, вы подтверждаете, что у вас есть законное основание для его загрузки и использования через сервис в личных целях. Это может быть: законно приобретённый экземпляр, ваша рукопись, произведение в общественном достоянии, открытая публикация, служебное произведение, переданное вам автором, или иное законное основание. Сервис не требует от вас быть правообладателем — но требует подтверждения законности использования. Ответственность за достоверность подтверждения и за законность загрузки несёте вы." },
      { h: "2. Лицензия, которую вы предоставляете", b: "Вы предоставляете Исполнителю безвозмездную, неисключительную, ограниченную сроком хранения файла лицензию на: (а) запись файла в систему хранения; (б) техническое воспроизведение в объёме, необходимом для индексации; (в) извлечение фрагментов текста и их обработку, в том числе с привлечением подрядчика Google Vertex AI для построения эмбеддингов и генерации ответов AI-ассистента; (г) формирование разбора и ответов ассистента; (д) выдачу результата анализа лично вам. Лицензия не даёт права публиковать файл, передавать его третьим лицам, использовать вне контекста оказания услуги или включать в общий каталог." },
      { h: "3. Приватность файла", b: "Загруженный файл виден только вам. Файл не публикуется, не индексируется поисковыми системами, не передаётся другим пользователям и не используется нами или нашими подрядчиками для обучения, дообучения или тонкой настройки моделей машинного обучения." },
      { h: "4. Чего сервис не делает", b: "Сервис не предоставляет вам имущественных прав на произведение, не заменяет лицензионный договор с правообладателем и не выдаёт полного текста загруженного файла «по главам». Применяются технические ограничения на длину одновременно выдаваемых фрагментов; попытки обойти их являются нарушением Пользовательского соглашения." },
      { h: "5. Блокировка по жалобе правообладателя", b: "При поступлении мотивированной жалобы от правообладателя или судебного предписания мы вправе временно ограничить доступ к файлу и связанному анализу. Порядок описан в документе «Жалоба правообладателя». Вы можете направить встречное обращение, если считаете блокировку необоснованной. Информационный посредник, своевременно принявший меры по обращению, освобождается от ответственности по правилам ст. 1253.1 Гражданского кодекса РФ." },
      { h: "6. Удаление", b: "Вы можете удалить книгу из библиотеки в любой момент. Файл и связанные с ним векторные индексы удаляются из активных хранилищ в течение 7 дней; из резервных копий — по расписанию, но не позднее 60 дней." },
    ],
  },
  copyright: {
    title: "Жалоба правообладателя",
    eyebrow: "Защита авторских прав",
    updated: "Редакция от 1 мая 2026",
    intro: "Если вы считаете, что в ремарке кто-то неправомерно использует ваше произведение, направьте заявление по форме ниже или на электронный адрес abuse@remarka.app. Заявление рассматривается в срок не более 10 рабочих дней; при очевидной обоснованности доступ к спорному материалу ограничивается в разумный срок, как правило, не более 24 часов с момента получения мотивированной жалобы. Если вы — пользователь, чей файл был ограничен по такой жалобе, и считаете её необоснованной — направьте встречное обращение на тот же адрес. Сервис действует в качестве информационного посредника по смыслу ст. 1253.1 Гражданского кодекса РФ.",
    sections: null,
  },
};

const LEGAL_KEYS = Object.keys(LEGAL_DOCS) as LegalKey[];

export function LegalPage({ docKey }: { docKey: string }) {
  const key = LEGAL_KEYS.includes(docKey as LegalKey) ? (docKey as LegalKey) : "terms";
  const doc = LEGAL_DOCS[key];

  return (
    <div className="container legal-page screen-fade">
      <div className="legal-grid">
        <aside className="legal-toc">
          <div className="mono eyebrow" style={{ marginBottom: 12 }}>Документы</div>
          <div className="legal-toc-list">
            {LEGAL_KEYS.map((item) => (
              <Link
                key={item}
                className={`legal-toc-link ${item === key ? "active" : ""}`}
                href={`/legal/${item}`}
              >
                {LEGAL_DOCS[item].title}
              </Link>
            ))}
          </div>
          <div className="hr" style={{ margin: "24px 0" }} />
          <div style={{ color: "var(--ink-faint)", fontSize: 12, lineHeight: 1.6 }}>
            {key === "copyright" ? "Прямой e-mail:" : "Вопросы по документам —"}
            <br />
            <a
              href={`mailto:${key === "copyright" ? "abuse" : "hello"}@remarka.app`}
              className="lnk"
            >
              {key === "copyright" ? "abuse@remarka.app" : "hello@remarka.app"}
            </a>
          </div>
        </aside>

        {key === "copyright" ? <CopyrightDoc doc={doc} /> : <TextDoc doc={doc} />}
      </div>
    </div>
  );
}

function TextDoc({ doc }: { doc: (typeof LEGAL_DOCS)[LegalKey] }) {
  return (
    <article className="legal-doc">
      <div className="mono eyebrow">{doc.eyebrow}</div>
      <h1 className="legal-title">{doc.title}</h1>
      <div className="legal-updated">{doc.updated}</div>
      <p className="legal-intro">{doc.intro}</p>
      <div className="legal-sections">
        {doc.sections?.map((section) => (
          <section key={section.h} className="legal-section">
            <h3>{section.h}</h3>
            <p>{section.b}</p>
          </section>
        ))}
      </div>
      <div className="legal-foot">
        <div className="mono" style={{ color: "var(--ink-faint)" }}>
          {doc.updated}
        </div>
        <Link className="btn btn-plain btn-sm" href="/">
          ← На главную
        </Link>
      </div>
    </article>
  );
}

type ClaimantType = "rightsholder" | "authorized_person" | "org_representative";

const CLAIMANT_TYPE_OPTIONS: Array<{ value: ClaimantType; label: string; hint: string }> = [
  {
    value: "rightsholder",
    label: "Правообладатель лично",
    hint: "Я — автор/композитор/иной правообладатель.",
  },
  {
    value: "authorized_person",
    label: "Доверенное лицо",
    hint: "Действую по доверенности (понадобятся реквизиты).",
  },
  {
    value: "org_representative",
    label: "Представитель организации",
    hint: "Издательство, лейбл, агентство — на основании устава или внутреннего полномочия.",
  },
];

const MAX_ATTACHMENT_COUNT = 5;
const MAX_ATTACHMENT_SIZE_BYTES = 20 * 1024 * 1024;
const ALLOWED_ATTACHMENT_ACCEPT = ".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

interface SubmitResultOk {
  ok: true;
  complaintId: string;
}

function CopyrightDoc({ doc }: { doc: (typeof LEGAL_DOCS)["copyright"] }) {
  const [submitted, setSubmitted] = useState<SubmitResultOk | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [form, setForm] = useState({
    claimantType: "rightsholder" as ClaimantType,
    claimantName: "",
    claimantOrganization: "",
    claimantEmail: "",
    workTitle: "",
    disputedUrls: "",
    rightsBasis: "",
    powerOfAttorneyDetails: "",
    description: "",
    sworn: false,
  });
  const [files, setFiles] = useState<File[]>([]);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [captchaToken, setCaptchaToken] = useState<string | null>(null);
  const captchaResetRef = useRef<(() => void) | null>(null);

  const captchaSiteKey = process.env.NEXT_PUBLIC_CAPTCHA_SITE_KEY || null;
  // Если сайт-ключ задан — требуем непустой токен. Если нет (dev) —
  // пускаем сабмит без токена; серверная сторона тоже работает в no-op
  // режиме при отсутствии CAPTCHA_SECRET_KEY.
  const captchaReady = captchaSiteKey ? Boolean(captchaToken) : true;

  const requiresPoa = form.claimantType === "authorized_person";
  const canSubmit =
    !submitting &&
    Boolean(
      form.claimantName &&
        form.claimantEmail &&
        form.workTitle &&
        form.disputedUrls &&
        form.rightsBasis &&
        form.description &&
        form.sworn &&
        (!requiresPoa || form.powerOfAttorneyDetails) &&
        captchaReady,
    );

  function resetForm() {
    setForm({
      claimantType: "rightsholder",
      claimantName: "",
      claimantOrganization: "",
      claimantEmail: "",
      workTitle: "",
      disputedUrls: "",
      rightsBasis: "",
      powerOfAttorneyDetails: "",
      description: "",
      sworn: false,
    });
    setFiles([]);
    setFilesError(null);
    setSubmitError(null);
    setCaptchaToken(null);
    captchaResetRef.current?.();
  }

  function handleFilesAdd(picked: FileList | null) {
    if (!picked || picked.length === 0) return;
    const existing = files.slice();
    const errors: string[] = [];

    for (const file of Array.from(picked)) {
      if (existing.length >= MAX_ATTACHMENT_COUNT) {
        errors.push(`Максимум ${MAX_ATTACHMENT_COUNT} файлов.`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_SIZE_BYTES) {
        errors.push(`«${file.name}» больше 20 МБ.`);
        continue;
      }
      const lowerName = file.name.toLowerCase();
      const acceptable =
        lowerName.endsWith(".pdf") ||
        lowerName.endsWith(".jpg") ||
        lowerName.endsWith(".jpeg") ||
        lowerName.endsWith(".png");
      if (!acceptable) {
        errors.push(`«${file.name}» — неподдерживаемый формат. Только PDF, JPG, PNG.`);
        continue;
      }
      existing.push(file);
    }

    setFiles(existing);
    setFilesError(errors.length > 0 ? errors.join(" ") : null);
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setSubmitError(null);

    const body = new FormData();
    body.set("claimantType", form.claimantType);
    body.set("claimantName", form.claimantName);
    if (form.claimantOrganization) body.set("claimantOrganization", form.claimantOrganization);
    body.set("claimantEmail", form.claimantEmail);
    body.set("workTitle", form.workTitle);
    body.set("disputedUrls", form.disputedUrls);
    body.set("rightsBasis", form.rightsBasis);
    if (form.powerOfAttorneyDetails) {
      body.set("powerOfAttorneyDetails", form.powerOfAttorneyDetails);
    }
    body.set("description", form.description);
    body.set("sworn", "true");
    if (captchaToken) body.set("captchaToken", captchaToken);
    for (const file of files) {
      body.append("attachments", file);
    }

    try {
      const response = await fetch("/api/legal/copyright-complaint", {
        method: "POST",
        body,
      });

      const json = (await response.json().catch(() => null)) as
        | { complaintId?: string; error?: string }
        | null;

      if (!response.ok) {
        const message =
          json?.error ||
          (response.status === 429
            ? "Слишком много заявлений за короткое время. Попробуйте позже."
            : "Не удалось отправить заявление. Попробуйте ещё раз или напишите на abuse@remarka.app.");
        setSubmitError(message);
        // На любую ошибку — ресетим captcha, чтобы пользователь смог отправить
        // снова с новым токеном (Turnstile не позволяет переиспользовать).
        captchaResetRef.current?.();
        setCaptchaToken(null);
        return;
      }

      if (!json?.complaintId) {
        setSubmitError("Сервер вернул некорректный ответ. Попробуйте ещё раз.");
        return;
      }

      setSubmitted({ ok: true, complaintId: json.complaintId });
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? `Сетевая ошибка: ${error.message}`
          : "Сетевая ошибка. Попробуйте ещё раз.",
      );
      captchaResetRef.current?.();
      setCaptchaToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article className="legal-doc">
      <div className="mono eyebrow">{doc.eyebrow}</div>
      <h1 className="legal-title">{doc.title}</h1>
      <div className="legal-updated">{doc.updated}</div>
      <p className="legal-intro">{doc.intro}</p>

      {submitted ? (
        <div className="complaint-done">
          <div className="complaint-check">
            <Check size={18} />
          </div>
          <h3 style={{ fontSize: 22, marginTop: 16 }}>Заявление зарегистрировано</h3>
          <p className="muted" style={{ margin: "10px auto 0", maxWidth: 480 }}>
            Номер обращения:{" "}
            <span className="mono" style={{ fontSize: 13 }}>
              {submitted.complaintId}
            </span>
            <br />
            Срок рассмотрения — до 10 рабочих дней. При очевидной обоснованности материал
            блокируется в течение 24 часов.
          </p>
          <p className="muted" style={{ margin: "12px auto 0", maxWidth: 480, fontSize: 13 }}>
            Дополнительные документы можно прислать на{" "}
            <a className="lnk" href={`mailto:abuse@remarka.app?subject=${encodeURIComponent(`Жалоба ${submitted.complaintId}`)}`}>
              abuse@remarka.app
            </a>
            {" "}с указанием номера заявки.
          </p>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ marginTop: 22 }}
            onClick={() => {
              setSubmitted(null);
              resetForm();
            }}
          >
            Подать ещё одно
          </button>
        </div>
      ) : (
        <form className="complaint-form" onSubmit={handleSubmit} noValidate>
          <div className="complaint-claimant-type">
            <div className="complaint-label" style={{ marginBottom: 10 }}>
              Я подаю заявление как<span className="req"> *</span>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {CLAIMANT_TYPE_OPTIONS.map((option) => {
                const checked = form.claimantType === option.value;
                return (
                  <label
                    key={option.value}
                    style={{
                      alignItems: "flex-start",
                      background: checked ? "var(--paper-2)" : "transparent",
                      border: `1px solid ${checked ? "var(--ink)" : "var(--rule)"}`,
                      borderRadius: "var(--r)",
                      cursor: "pointer",
                      display: "flex",
                      gap: 10,
                      padding: "10px 12px",
                      transition: "border-color 120ms",
                    }}
                  >
                    <input
                      type="radio"
                      name="claimantType"
                      value={option.value}
                      checked={checked}
                      onChange={() => setForm({ ...form, claimantType: option.value })}
                      style={{ marginTop: 3 }}
                    />
                    <span style={{ fontSize: 14 }}>
                      <span style={{ color: "var(--ink)", fontWeight: 500 }}>{option.label}</span>
                      <span className="muted" style={{ display: "block", fontSize: 12, marginTop: 2 }}>
                        {option.hint}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </div>

          <div className="complaint-grid" style={{ marginTop: 16 }}>
            <LegalField label="Ф.И.О. заявителя" required>
              <input
                value={form.claimantName}
                onChange={(event) => setForm({ ...form, claimantName: event.target.value })}
                placeholder="Иванов Иван Иванович"
                maxLength={200}
              />
            </LegalField>
            <LegalField label="Организация" hint="если от имени юрлица">
              <input
                value={form.claimantOrganization}
                onChange={(event) =>
                  setForm({ ...form, claimantOrganization: event.target.value })
                }
                placeholder="ООО «Издательство»"
                maxLength={200}
              />
            </LegalField>
            <LegalField label="E-mail для ответа" required>
              <input
                type="email"
                value={form.claimantEmail}
                onChange={(event) => setForm({ ...form, claimantEmail: event.target.value })}
                placeholder="legal@example.com"
                maxLength={200}
              />
            </LegalField>
            <LegalField label="Название произведения" required>
              <input
                value={form.workTitle}
                onChange={(event) => setForm({ ...form, workTitle: event.target.value })}
                placeholder="«Название», автор"
                maxLength={500}
              />
            </LegalField>
            <LegalField
              label="URL страницы / идентификатор книги в ремарке"
              required
              full
              hint="Можно несколько — каждый с новой строки"
            >
              <textarea
                rows={3}
                value={form.disputedUrls}
                onChange={(event) => setForm({ ...form, disputedUrls: event.target.value })}
                placeholder={"https://remarka.app/book/...\nили bookId-cuid"}
                maxLength={4000}
              />
            </LegalField>
            <LegalField
              label="Основание прав"
              required
              full
              hint="Договор с автором, свидетельство о регистрации, авторство и т.п."
            >
              <input
                value={form.rightsBasis}
                onChange={(event) => setForm({ ...form, rightsBasis: event.target.value })}
                placeholder="Договор № 12 от 01.01.2024 / автор произведения"
                maxLength={2000}
              />
            </LegalField>
            {requiresPoa && (
              <LegalField
                label="Реквизиты доверенности"
                required
                full
                hint="Номер, дата, кем выдана, объём полномочий"
              >
                <textarea
                  rows={3}
                  value={form.powerOfAttorneyDetails}
                  onChange={(event) =>
                    setForm({ ...form, powerOfAttorneyDetails: event.target.value })
                  }
                  placeholder="Доверенность № 42 от 01.03.2026, выдана автором Ивановым И.И., полномочия включают подачу претензий и заявлений о нарушении"
                  maxLength={2000}
                />
              </LegalField>
            )}
            <LegalField label="Описание нарушения" required full>
              <textarea
                rows={5}
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                placeholder="Какая часть произведения используется, как вы обнаружили, чем нарушены ваши права…"
                maxLength={8000}
              />
            </LegalField>
          </div>

          <div className="complaint-attachments">
            <div className="complaint-label" style={{ marginBottom: 8 }}>
              Подтверждающие документы
              <span className="complaint-hint">
                {" "}— PDF / JPG / PNG, до {MAX_ATTACHMENT_COUNT} файлов, 20 МБ каждый
              </span>
            </div>
            <label
              style={{
                alignItems: "center",
                border: "1px dashed var(--rule)",
                borderRadius: "var(--r)",
                color: "var(--ink-muted)",
                cursor: "pointer",
                display: "flex",
                fontSize: 13,
                gap: 10,
                justifyContent: "center",
                padding: "14px 16px",
              }}
            >
              <Paperclip size={16} />
              <span>
                Прикрепить файлы — договор, свидетельство, скан паспорта автора и т.п.
              </span>
              <input
                type="file"
                multiple
                accept={ALLOWED_ATTACHMENT_ACCEPT}
                onChange={(event) => {
                  handleFilesAdd(event.target.files);
                  event.target.value = "";
                }}
                style={{ display: "none" }}
              />
            </label>
            {files.length > 0 && (
              <ul
                style={{
                  display: "grid",
                  gap: 6,
                  listStyle: "none",
                  margin: "10px 0 0",
                  padding: 0,
                }}
              >
                {files.map((file, idx) => (
                  <li
                    key={`${file.name}-${idx}`}
                    style={{
                      alignItems: "center",
                      background: "var(--paper-2)",
                      borderRadius: "var(--r-sm)",
                      display: "flex",
                      fontSize: 13,
                      gap: 10,
                      padding: "8px 10px",
                    }}
                  >
                    <Paperclip size={14} />
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {file.name}
                    </span>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {formatBytes(file.size)}
                    </span>
                    <button
                      type="button"
                      className="btn-plain"
                      style={{ borderRadius: 4, padding: 4 }}
                      onClick={() => setFiles(files.filter((_, i) => i !== idx))}
                      aria-label={`Убрать ${file.name}`}
                    >
                      <X size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {filesError && (
              <div style={{ color: "var(--danger, #c53030)", fontSize: 12, marginTop: 8 }}>
                {filesError}
              </div>
            )}
          </div>

          <label className="complaint-sworn">
            <input
              type="checkbox"
              checked={form.sworn}
              onChange={(event) => setForm({ ...form, sworn: event.target.checked })}
            />
            <span>
              Подтверждаю, что сведения достоверны, я действую добросовестно и имею право
              направлять это заявление от своего имени или по доверенности.
            </span>
          </label>

          <CaptchaWidget
            siteKey={captchaSiteKey}
            onVerify={setCaptchaToken}
            resetRef={captchaResetRef}
          />

          {submitError && (
            <div
              style={{
                background: "var(--danger-bg, rgba(197,48,48,0.08))",
                border: "1px solid var(--danger, #c53030)",
                borderRadius: "var(--r)",
                color: "var(--danger, #c53030)",
                fontSize: 13,
                marginTop: 16,
                padding: "10px 12px",
              }}
            >
              {submitError}
            </div>
          )}

          <div
            className="row"
            style={{ flexWrap: "wrap", gap: 12, justifyContent: "space-between", marginTop: 20 }}
          >
            <div className="muted" style={{ fontSize: 13 }}>
              Или отправьте заявление на{" "}
              <a className="lnk" href="mailto:abuse@remarka.app">
                abuse@remarka.app
              </a>
            </div>
            <button
              type="submit"
              className="btn btn-mark"
              disabled={!canSubmit}
              style={{ opacity: canSubmit ? 1 : 0.5 }}
            >
              {submitting ? (
                <>
                  <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} />{" "}
                  Отправляем…
                </>
              ) : (
                <>
                  Отправить заявление <ArrowRight size={14} />
                </>
              )}
            </button>
          </div>
        </form>
      )}
    </article>
  );
}

function LegalField({
  label,
  hint,
  children,
  required,
  full,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  required?: boolean;
  full?: boolean;
}) {
  return (
    <label className={`complaint-field ${full ? "full" : ""}`}>
      <div className="complaint-label">
        {label}
        {required && <span className="req"> *</span>}
        {hint && <span className="complaint-hint"> — {hint}</span>}
      </div>
      {children}
    </label>
  );
}
