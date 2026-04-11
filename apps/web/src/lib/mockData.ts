export interface Book {
  id: string;
  title: string;
  author: string;
  uploadedAt: string;
  uploadedBy: {
    id: string;
    name: string;
    avatar?: string;
  };
  status: "processing" | "ready";
  chaptersCount: number;
  charactersCount: number;
  themesCount: number;
  locationsCount: number;
  isPublic: boolean;
  likesCount: number;
  isLiked: boolean;
}

export interface Character {
  id: string;
  bookId: string;
  name: string;
  role: string;
  description: string;
  arc: string;
  relatedQuotes: Quote[];
}

export interface Theme {
  id: string;
  bookId: string;
  name: string;
  description: string;
  development: string;
  relatedQuotes: Quote[];
}

export interface Location {
  id: string;
  bookId: string;
  name: string;
  description: string;
  significance: string;
  relatedQuotes: Quote[];
}

export interface Chapter {
  id: string;
  bookId: string;
  number: number;
  title: string;
  summary: string;
  keyEvents: string[];
  charactersAppearing: string[];
}

export interface Quote {
  id: string;
  bookId: string;
  text: string;
  context: string;
  chapterNumber: number;
  relatedTo: {
    type: "character" | "theme" | "location" | "event";
    id: string;
    name: string;
  }[];
}

export interface Event {
  id: string;
  bookId: string;
  title: string;
  description: string;
  chapterNumber: number;
  significance: string;
}

export type PlanType = "basic" | "plus";

export interface UserPlan {
  type: PlanType;
  name: string;
  features: {
    privateBooks: boolean;
    maxBooks: number | "unlimited";
    advancedAnalysis: boolean;
    exportFeatures: boolean;
  };
}

export const plans: Record<PlanType, UserPlan> = {
  basic: {
    type: "basic",
    name: "Базовый",
    features: {
      privateBooks: false,
      maxBooks: 5,
      advancedAnalysis: false,
      exportFeatures: false,
    },
  },
  plus: {
    type: "plus",
    name: "Плюс",
    features: {
      privateBooks: true,
      maxBooks: "unlimited",
      advancedAnalysis: true,
      exportFeatures: true,
    },
  },
};

// Mock current user
export const currentUser = {
  id: "user1",
  name: "Анна Петрова",
  email: "anna@example.com",
  plan: plans.plus,
};

// Mock data
export const mockBooks: Book[] = [
  {
    id: "1",
    title: "Преступление и наказание",
    author: "Фёдор Достоевский",
    uploadedAt: "2026-03-15",
    uploadedBy: currentUser,
    status: "ready",
    chaptersCount: 6,
    charactersCount: 8,
    themesCount: 5,
    locationsCount: 4,
    isPublic: true,
    likesCount: 142,
    isLiked: true,
  },
  {
    id: "2",
    title: "Мастер и Маргарита",
    author: "Михаил Булгаков",
    uploadedAt: "2026-04-01",
    uploadedBy: {
      id: "user2",
      name: "Дмитрий Соколов",
    },
    status: "ready",
    chaptersCount: 32,
    charactersCount: 15,
    themesCount: 7,
    locationsCount: 6,
    isPublic: true,
    likesCount: 203,
    isLiked: false,
  },
  {
    id: "3",
    title: "Анна Каренина",
    author: "Лев Толстой",
    uploadedAt: "2026-03-28",
    uploadedBy: {
      id: "user3",
      name: "Елена Морозова",
    },
    status: "ready",
    chaptersCount: 8,
    charactersCount: 12,
    themesCount: 6,
    locationsCount: 8,
    isPublic: true,
    likesCount: 187,
    isLiked: false,
  },
  {
    id: "4",
    title: "Евгений Онегин",
    author: "Александр Пушкин",
    uploadedAt: "2026-04-05",
    uploadedBy: {
      id: "user4",
      name: "Игорь Волков",
    },
    status: "ready",
    chaptersCount: 8,
    charactersCount: 6,
    themesCount: 4,
    locationsCount: 5,
    isPublic: true,
    likesCount: 95,
    isLiked: true,
  },
  {
    id: "5",
    title: "Война и мир",
    author: "Лев Толстой",
    uploadedAt: "2026-04-08",
    uploadedBy: currentUser,
    status: "ready",
    chaptersCount: 15,
    charactersCount: 20,
    themesCount: 8,
    locationsCount: 12,
    isPublic: false,
    likesCount: 0,
    isLiked: false,
  },
];

export const mockCharacters: Character[] = [
  {
    id: "c1",
    bookId: "1",
    name: "Родион Раскольников",
    role: "Главный герой",
    description: "Бывший студент, живущий в крайней бедности. Разрабатывает теорию о «необыкновенных людях», имеющих право переступать моральные законы.",
    arc: "От идейного убийцы к осознанию вины и поиску искупления через страдание и любовь",
    relatedQuotes: [],
  },
  {
    id: "c2",
    bookId: "1",
    name: "Соня Мармеладова",
    role: "Символ спасения",
    description: "Дочь пьяницы-чиновника, вынужденная заниматься проституцией ради семьи. Глубоко религиозна.",
    arc: "Воплощение христианского смирения и жертвенной любви, становится путеводной звездой для Раскольникова",
    relatedQuotes: [],
  },
  {
    id: "c3",
    bookId: "1",
    name: "Порфирий Петрович",
    role: "Следователь",
    description: "Проницательный следователь, ведущий дело об убийстве. Использует психологическое давление.",
    arc: "Раскрывает преступление через понимание психологии преступника, а не улики",
    relatedQuotes: [],
  },
];

export const mockThemes: Theme[] = [
  {
    id: "t1",
    bookId: "1",
    name: "Теория о «сверхчеловеке»",
    description: "Идея Раскольникова о делении людей на «обыкновенных» и «необыкновенных», где последним дозволено переступать моральные законы ради высших целей.",
    development: "Теория развивается от интеллектуального концепта к практической проверке убийством, затем разрушается под весом совести и реальности",
    relatedQuotes: [],
  },
  {
    id: "t2",
    bookId: "1",
    name: "Искупление через страдание",
    description: "Путь к духовному возрождению лежит через принятие и переживание страдания, а не через рациональное оправдание.",
    development: "От отрицания вины к постепенному осознанию, завершается добровольной каторгой как путем искупления",
    relatedQuotes: [],
  },
  {
    id: "t3",
    bookId: "1",
    name: "Бедность и социальное неравенство",
    description: "Материальная нищета как фактор, толкающий людей на крайние поступки и моральные компромиссы.",
    development: "Показана через судьбы разных персонажей: Раскольникова, Мармеладовых, Дуни",
    relatedQuotes: [],
  },
];

export const mockLocations: Location[] = [
  {
    id: "l1",
    bookId: "1",
    name: "Комната Раскольникова",
    description: "Каморка на чердаке дома, похожая на гроб. Тесная, низкая, с жёлтыми обоями.",
    significance: "Символ нищеты и духовного заточения героя. Место рождения теории и внутренней борьбы.",
    relatedQuotes: [],
  },
  {
    id: "l2",
    bookId: "1",
    name: "Квартира старухи-процентщицы",
    description: "Небольшая квартира на четвёртом этаже. Место совершения преступления.",
    significance: "Центральная точка криминального сюжета. Место, которое преследует Раскольникова в кошмарах.",
    relatedQuotes: [],
  },
  {
    id: "l3",
    bookId: "1",
    name: "Сенная площадь",
    description: "Шумная площадь в центре бедного района Петербурга. Место народных гуляний и торговли.",
    significance: "Место первого публичного покаяния Раскольникова. Символ возвращения к людям и жизни.",
    relatedQuotes: [],
  },
  {
    id: "l4",
    bookId: "1",
    name: "Комната Сони Мармеладовой",
    description: "Убогая угловая комната неправильной формы с тремя окнами, выходящими на канаву.",
    significance: "Пространство духовного пробуждения. Здесь Раскольников признаётся Соне и слушает чтение о воскрешении Лазаря.",
    relatedQuotes: [],
  },
];

export const mockChapters: Chapter[] = [
  {
    id: "ch1",
    bookId: "1",
    number: 1,
    title: "Часть первая",
    summary: "Раскольников планирует убийство процентщицы. Встреча с Мармеладовым в трактире открывает тему страдания бедняков.",
    keyEvents: [
      "Раскольников делает «пробу» — идет к старухе-процентщице",
      "Встреча с пьяным Мармеладовым, рассказ о его семье",
      "Получение письма от матери о планируемом браке сестры",
    ],
    charactersAppearing: ["Раскольников", "Мармеладов", "Алёна Ивановна"],
  },
  {
    id: "ch2",
    bookId: "1",
    number: 2,
    title: "Часть вторая",
    summary: "Убийство и его немедленные последствия. Раскольников заболевает от нервного потрясения.",
    keyEvents: [
      "Раскольников убивает старуху и её сестру Лизавету",
      "Возвращение домой, сокрытие улик",
      "Нервная болезнь и бред",
    ],
    charactersAppearing: ["Раскольников", "Разумихин", "Настасья"],
  },
];

export const mockQuotes: Quote[] = [
  {
    id: "q1",
    bookId: "1",
    text: "Тварь ли я дрожащая или право имею?",
    context: "Раскольников мучается вопросом о своей принадлежности к «необыкновенным» людям",
    chapterNumber: 3,
    relatedTo: [
      { type: "character", id: "c1", name: "Родион Раскольников" },
      { type: "theme", id: "t1", name: "Теория о «сверхчеловеке»" },
    ],
  },
  {
    id: "q2",
    bookId: "1",
    text: "Страдание — великая вещь.",
    context: "Соня объясняет Раскольникову путь к искуплению",
    chapterNumber: 5,
    relatedTo: [
      { type: "character", id: "c2", name: "Соня Мармеладова" },
      { type: "theme", id: "t2", name: "Искупление через страдание" },
    ],
  },
  {
    id: "q3",
    bookId: "1",
    text: "Боль и страдание всегда обязательны для широкого сознания и глубокого сердца.",
    context: "Размышление о природе страдания выдающихся личностей",
    chapterNumber: 1,
    relatedTo: [
      { type: "theme", id: "t2", name: "Искупление через страдание" },
      { type: "theme", id: "t1", name: "Теория о «сверхчеловеке»" },
    ],
  },
];

export const mockEvents: Event[] = [
  {
    id: "e1",
    bookId: "1",
    title: "Убийство процентщицы",
    description: "Раскольников убивает Алёну Ивановну и случайно — её сестру Лизавету",
    chapterNumber: 1,
    significance: "Ключевое событие, запускающее весь психологический конфликт романа",
  },
  {
    id: "e2",
    bookId: "1",
    title: "Признание Соне",
    description: "Раскольников признаётся Соне в убийстве и получает совет принять страдание",
    chapterNumber: 4,
    significance: "Поворотный момент в духовном пути героя",
  },
  {
    id: "e3",
    bookId: "1",
    title: "Явка с повинной",
    description: "Раскольников приходит в полицию и признаётся в преступлении",
    chapterNumber: 6,
    significance: "Завершение внешнего конфликта, начало пути искупления",
  },
];
