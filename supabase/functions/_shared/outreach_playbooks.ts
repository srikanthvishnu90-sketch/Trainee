// Field playbooks for personalized outreach (career_outreach_personalize.ts). Data, not code: each field's structure, length norm, the asks it allows, when a referral is warranted, follow-up cadence and timing. The drafter is told the playbook; the quality gate enforces max_words, one ask, and the ask kind.
// Plain data in a .ts module (not a JSON import: the staged-handler loaders read only JS/TS modules).
const PLAYBOOKS = {
  "version": 1,
  "playbooks": [
    {
      "id": "ib",
      "label": "investment banking",
      "match": {
        "title": [
          "investment bank",
          "banker",
          "m&a",
          "coverage",
          "leveraged finance",
          "levfin",
          "ecm",
          "dcm",
          "restructuring",
          "capital markets"
        ],
        "firm": [
          "goldman",
          "morgan stanley",
          "jpmorgan",
          "j.p. morgan",
          "evercore",
          "lazard",
          "centerview",
          "moelis",
          "pjt",
          "guggenheim",
          "houlihan",
          "jefferies",
          "perella",
          "william blair",
          "baird",
          "piper sandler",
          "rothschild",
          "qatalyst",
          "bank of america",
          "citi",
          "barclays",
          "ubs",
          "wells fargo securities",
          "lincoln international",
          "harris williams"
        ]
      },
      "structure": [
        "who_you_are",
        "specific_hook",
        "overlap",
        "ask"
      ],
      "max_words": 90,
      "ask": {
        "default": "call_15",
        "allowed": [
          "call_15",
          "advice_question"
        ],
        "referral": "never_cold"
      },
      "hook_kinds": [
        "deal",
        "group",
        "work",
        "talk",
        "post"
      ],
      "follow_up": {
        "days": [
          5,
          12
        ],
        "max": 2
      },
      "timing": "Banking recruiting runs early: summer analyst networking peaks in the spring and summer a year before the internship. Weekday mornings; never during a live deal you can see announced that week.",
      "norms": [
        "Name the group or a deal the firm announced, not 'banking' in general.",
        "Brevity: bankers read on a phone between models; three short sentences plus the ask.",
        "Ask for 10-15 minutes, never 'pick your brain'."
      ]
    },
    {
      "id": "swe",
      "label": "software engineering",
      "match": {
        "title": [
          "software engineer",
          "swe",
          "developer",
          "engineering manager",
          "staff engineer",
          "backend",
          "frontend",
          "full stack",
          "ml engineer",
          "machine learning engineer",
          "infrastructure",
          "sre",
          "devops",
          "data engineer"
        ],
        "firm": []
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "overlap",
        "ask"
      ],
      "max_words": 110,
      "ask": {
        "default": "advice_question",
        "allowed": [
          "advice_question",
          "call_15",
          "referral"
        ],
        "referral": "warm_and_role"
      },
      "hook_kinds": [
        "repo",
        "talk",
        "paper",
        "post",
        "work",
        "project"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "Any weekday; new-grad and intern cycles open in late summer and fall.",
      "norms": [
        "Open with the specific repo, talk or post and one concrete thing about it.",
        "Ask a question an engineer can answer in two lines, or for 15 minutes.",
        "A referral ask only when you already know them and name the exact role."
      ]
    },
    {
      "id": "pm",
      "label": "product management",
      "match": {
        "title": [
          "product manager",
          "product lead",
          "head of product",
          "apm",
          "group product",
          "product owner",
          "vp product"
        ],
        "firm": []
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "overlap",
        "ask"
      ],
      "max_words": 110,
      "ask": {
        "default": "call_15",
        "allowed": [
          "call_15",
          "advice_question",
          "referral"
        ],
        "referral": "warm_and_role"
      },
      "hook_kinds": [
        "launch",
        "post",
        "talk",
        "work",
        "project"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "APM programs open in late summer; weekday mornings.",
      "norms": [
        "Reference the product or launch they shipped, specifically.",
        "Show one product thought of yours in a sentence, then ask."
      ]
    },
    {
      "id": "consulting",
      "label": "consulting",
      "match": {
        "title": [
          "consultant",
          "engagement manager",
          "associate partner",
          "case team"
        ],
        "firm": [
          "mckinsey",
          "bain",
          "bcg",
          "boston consulting",
          "deloitte",
          "accenture",
          "oliver wyman",
          "kearney",
          "pwc",
          "ey-parthenon",
          "l.e.k.",
          "lek consulting",
          "strategy&"
        ]
      },
      "structure": [
        "who_you_are",
        "overlap",
        "specific_hook",
        "ask"
      ],
      "max_words": 100,
      "ask": {
        "default": "call_15",
        "allowed": [
          "call_15",
          "advice_question"
        ],
        "referral": "never_cold"
      },
      "hook_kinds": [
        "practice",
        "work",
        "talk",
        "post"
      ],
      "follow_up": {
        "days": [
          6,
          13
        ],
        "max": 2
      },
      "timing": "Recruiting for MBB peaks in late summer and early fall; reach out before applications open.",
      "norms": [
        "Name the practice or office.",
        "Structured and polite; one ask."
      ]
    },
    {
      "id": "vc",
      "label": "venture capital",
      "match": {
        "title": [
          "venture",
          "vc",
          "investor",
          "partner at",
          "principal",
          "investment associate"
        ],
        "firm": [
          "ventures",
          "capital partners",
          "a16z",
          "andreessen",
          "sequoia",
          "accel",
          "benchmark",
          "greylock",
          "index ventures",
          "lightspeed",
          "first round",
          "ycombinator",
          "y combinator"
        ]
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "ask"
      ],
      "max_words": 80,
      "ask": {
        "default": "advice_question",
        "allowed": [
          "advice_question",
          "call_15"
        ],
        "referral": "never"
      },
      "hook_kinds": [
        "post",
        "thesis",
        "investment",
        "talk",
        "podcast",
        "work"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "Any time; investors triage by the first line.",
      "norms": [
        "Lead with their thesis, post or an investment and your one-line take.",
        "Shortest of all: investors skim."
      ]
    },
    {
      "id": "research",
      "label": "research and professors",
      "match": {
        "title": [
          "professor",
          "phd",
          "researcher",
          "research scientist",
          "postdoc",
          "lecturer",
          "principal investigator",
          "lab"
        ],
        "firm": [
          "university",
          "college",
          "institute",
          "laboratory"
        ]
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "overlap",
        "ask"
      ],
      "max_words": 140,
      "ask": {
        "default": "advice_question",
        "allowed": [
          "advice_question",
          "call_15",
          "research_opportunity"
        ],
        "referral": "never"
      },
      "hook_kinds": [
        "paper",
        "talk",
        "lab",
        "course",
        "work"
      ],
      "follow_up": {
        "days": [
          10
        ],
        "max": 1
      },
      "timing": "Early in a semester or after a paper comes out; avoid finals weeks.",
      "norms": [
        "Name the paper or talk and one specific idea from it.",
        "Say what you have done that relates, from your facts only.",
        "Ask whether there is a way to help or learn more, not for a job."
      ]
    },
    {
      "id": "recruiter",
      "label": "recruiters",
      "match": {
        "title": [
          "recruiter",
          "talent acquisition",
          "talent partner",
          "university recruiting",
          "campus recruiting",
          "sourcer",
          "people partner"
        ],
        "firm": []
      },
      "structure": [
        "who_you_are",
        "role",
        "overlap",
        "ask"
      ],
      "max_words": 90,
      "ask": {
        "default": "role_consideration",
        "allowed": [
          "role_consideration",
          "call_15"
        ],
        "referral": "never"
      },
      "hook_kinds": [
        "role",
        "event",
        "post",
        "work"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "When the role is posted, or within two days of a campus event they ran.",
      "norms": [
        "Name the exact role or the event.",
        "Two lines on why you fit, from confirmed facts.",
        "Ask to be considered for that role or for a short call."
      ]
    },
    {
      "id": "alumni",
      "label": "alumni",
      "match": {
        "title": [],
        "firm": []
      },
      "structure": [
        "overlap",
        "who_you_are",
        "specific_hook",
        "ask"
      ],
      "max_words": 110,
      "ask": {
        "default": "call_15",
        "allowed": [
          "call_15",
          "advice_question",
          "referral"
        ],
        "referral": "warm_and_role"
      },
      "hook_kinds": [
        "work",
        "post",
        "talk",
        "deal",
        "project"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "Any weekday; alumni reply most when the school is in the first line.",
      "norms": [
        "Lead with the shared school, stated exactly.",
        "Then one specific thing about their path."
      ]
    },
    {
      "id": "founder",
      "label": "founders",
      "match": {
        "title": [
          "founder",
          "co-founder",
          "cofounder",
          "ceo",
          "cto"
        ],
        "firm": []
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "ask"
      ],
      "max_words": 90,
      "ask": {
        "default": "advice_question",
        "allowed": [
          "advice_question",
          "call_15"
        ],
        "referral": "never"
      },
      "hook_kinds": [
        "launch",
        "post",
        "product",
        "work",
        "talk"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "Avoid launch weeks; founders answer late evenings and weekends.",
      "norms": [
        "Show you used or read their product or post, specifically.",
        "Offer something concrete if your facts support it."
      ]
    },
    {
      "id": "general",
      "label": "professionals",
      "match": {
        "title": [],
        "firm": []
      },
      "structure": [
        "specific_hook",
        "who_you_are",
        "overlap",
        "ask"
      ],
      "max_words": 110,
      "ask": {
        "default": "call_15",
        "allowed": [
          "call_15",
          "advice_question",
          "referral"
        ],
        "referral": "warm_and_role"
      },
      "hook_kinds": [
        "work",
        "post",
        "talk",
        "paper",
        "project",
        "deal"
      ],
      "follow_up": {
        "days": [
          7
        ],
        "max": 1
      },
      "timing": "Weekday mornings in their time zone.",
      "norms": [
        "One specific thing about them, one about you, one ask."
      ]
    }
  ],
  "asks": {
    "call_15": {
      "label": "a 15-minute call",
      "cue": [
        "15 minutes",
        "15-minute",
        "fifteen minutes",
        "10 minutes",
        "10-minute",
        "quick call",
        "short call",
        "brief call",
        "a call",
        "to chat",
        "quick chat",
        "short chat",
        "coffee chat"
      ]
    },
    "advice_question": {
      "label": "one specific question",
      "cue": [
        "your advice",
        "would you advise",
        "how would you",
        "what would you",
        "how did you",
        "what do you",
        "would you recommend",
        "any advice",
        "your take",
        "what made you",
        "how do you"
      ]
    },
    "referral": {
      "label": "a referral for a named role",
      "cue": [
        "refer me",
        "referral",
        "put in a word",
        "pass my resume",
        "pass along my",
        "forward my resume"
      ]
    },
    "role_consideration": {
      "label": "consideration for a named role",
      "cue": [
        "be considered",
        "consider me",
        "considered for",
        "my application for",
        "my candidacy",
        "in the running",
        "a fit for"
      ]
    },
    "research_opportunity": {
      "label": "a way to help in the lab",
      "cue": [
        "help in your lab",
        "research opportunity",
        "assist with",
        "contribute to your",
        "join your lab",
        "undergraduate research"
      ]
    }
  },
  "generic_phrases": [
    "hope this email finds you well",
    "hope this finds you well",
    "pick your brain",
    "came across your profile",
    "i am reaching out to connect",
    "i'd love to connect",
    "would love to connect",
    "your impressive background",
    "your impressive career",
    "your impressive experience",
    "your journey",
    "i admire your work",
    "i am very passionate",
    "to whom it may concern",
    "dear sir or madam",
    "networking opportunity",
    "expand my network"
  ]
};
export default PLAYBOOKS;
