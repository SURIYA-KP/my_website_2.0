// Template gallery: one realistic, ready-to-edit example per Mermaid diagram type.
// Every entry is rendered in tests/diagram-studio.test.mjs, so keep them valid.

export interface Template {
  id: string;
  name: string;
  group: 'Process' | 'Software' | 'Data & charts' | 'Planning' | 'Ideas & strategy';
  description: string;
  beta?: boolean;
  code: string;
}

const t = (s: TemplateStringsArray) => s.raw.join('').replace(/^\n/, '').replace(/\s+$/, '') + '\n';

export const TEMPLATES: Template[] = [
  {
    id: 'flowchart',
    name: 'Flowchart',
    group: 'Process',
    description: 'CI/CD pipeline with decisions and loops',
    code: t`
flowchart LR
  push([Developer pushes code]) --> ci{CI checks pass?}
  ci -->|no| fix[Fix and recommit]
  fix --> push
  ci -->|yes| build[Build container image]
  build --> scan[Security scan]
  scan --> staging[(Deploy to staging)]
  staging --> e2e[Run end-to-end tests]
  e2e --> approve{Release approved?}
  approve -->|yes| prod[[Deploy to production]]
  approve -->|no| fix
  prod --> monitor[Monitor dashboards and alerts]

  classDef good fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef bad fill:#fee2e2,stroke:#dc2626,color:#7f1d1d
  class prod good
  class fix bad
`,
  },
  {
    id: 'ml-pipeline',
    name: 'ML pipeline',
    group: 'Process',
    description: 'Machine learning training pipeline with subgraphs',
    code: t`
flowchart TB
  subgraph data [Data]
    raw[(Raw events)] --> clean[Clean and deduplicate]
    clean --> features[Feature engineering]
    features --> split{Train / validation / test split}
  end
  subgraph training [Training]
    split --> train[Train model]
    train --> tune[Hyperparameter search]
    tune --> train
    train --> eval[Evaluate on validation set]
  end
  subgraph release [Release]
    eval -->|metrics above baseline| register[Register model version]
    register --> canary[Canary deploy to 5% of traffic]
    canary --> full[Full rollout]
  end
  eval -->|below baseline| features
  full --> drift[Monitor drift]
  drift -.->|retrain trigger| raw
`,
  },
  {
    id: 'sequence',
    name: 'Sequence',
    group: 'Software',
    description: 'Login flow with token validation',
    code: t`
sequenceDiagram
  autonumber
  actor U as User
  participant B as Browser
  participant A as Auth service
  participant API as Profile API
  U->>B: Enter email and password
  B->>+A: POST /login
  A->>A: Check password hash and MFA
  alt credentials valid
    A-->>B: 200 OK with access token
  else invalid
    A-->>B: 401 Unauthorized
  end
  deactivate A
  B->>+API: GET /me (Bearer token)
  API->>A: Validate token
  A-->>API: Token valid
  API-->>-B: Profile JSON
  B-->>U: Show dashboard
  Note over B,A: Access tokens expire after 15 minutes
`,
  },
  {
    id: 'class',
    name: 'Class',
    group: 'Software',
    description: 'Online shop domain model',
    code: t`
classDiagram
  direction LR
  class Customer {
    +String name
    +String email
    +placeOrder(cart) Order
  }
  class Order {
    +UUID id
    +Date createdAt
    +OrderStatus status
    +total() Money
  }
  class LineItem {
    +int quantity
    +Money unitPrice
  }
  class Product {
    +String sku
    +String title
    +Money price
  }
  class OrderStatus {
    <<enumeration>>
    PENDING
    PAID
    SHIPPED
    CANCELLED
  }
  Customer "1" --> "*" Order : places
  Order "1" *-- "1..*" LineItem : contains
  LineItem "*" --> "1" Product : refers to
  Order ..> OrderStatus
`,
  },
  {
    id: 'state',
    name: 'State',
    group: 'Software',
    description: 'Order lifecycle state machine',
    code: t`
stateDiagram-v2
  [*] --> Draft
  Draft --> Submitted : customer checks out
  Submitted --> Paid : payment captured
  Submitted --> Cancelled : payment failed
  Paid --> Fulfilment
  state Fulfilment {
    [*] --> Picking
    Picking --> Packing
    Packing --> Shipped
  }
  Fulfilment --> Delivered : carrier confirms
  Delivered --> Returned : within 30 days
  Delivered --> [*]
  Returned --> [*]
  Cancelled --> [*]
  note right of Paid : Invoice is emailed automatically
`,
  },
  {
    id: 'er',
    name: 'Entity relationship',
    group: 'Software',
    description: 'Blog database schema',
    code: t`
erDiagram
  USER ||--o{ POST : writes
  USER ||--o{ COMMENT : writes
  POST ||--o{ COMMENT : has
  POST }o--o{ TAG : "tagged with"
  USER {
    int id PK
    string email UK
    string display_name
    datetime created_at
  }
  POST {
    int id PK
    int author_id FK
    string title
    text body
    boolean published
  }
  COMMENT {
    int id PK
    int post_id FK
    int user_id FK
    text body
  }
  TAG {
    int id PK
    string name UK
  }
`,
  },
  {
    id: 'journey',
    name: 'User journey',
    group: 'Process',
    description: 'Ordering groceries online, scored per step',
    code: t`
journey
  title Ordering groceries online
  section Discover
    Open the app: 5: Customer
    Search for products: 3: Customer
    Compare prices: 2: Customer
  section Checkout
    Choose delivery slot: 2: Customer
    Pay with saved card: 5: Customer, Payment provider
  section Delivery
    Track the driver: 4: Customer, Driver
    Receive groceries: 5: Customer, Driver
    Report a missing item: 1: Customer, Support
`,
  },
  {
    id: 'gantt',
    name: 'Gantt',
    group: 'Planning',
    description: 'Website redesign project plan',
    code: t`
gantt
  title Website redesign
  dateFormat YYYY-MM-DD
  axisFormat %b %d
  excludes weekends
  section Discovery
    Stakeholder interviews :done, interviews, 2026-01-05, 5d
    Analytics review :done, analytics, 2026-01-07, 4d
  section Design
    Wireframes :active, wire, after interviews, 7d
    Visual design :design, after wire, 8d
    Design sign-off :milestone, signoff, after design, 0d
  section Build
    Frontend :fe, after signoff, 12d
    CMS integration :cms, after signoff, 9d
    QA and accessibility :qa, after fe, 5d
  section Launch
    Go live :crit, milestone, launch, after qa, 0d
`,
  },
  {
    id: 'pie',
    name: 'Pie',
    group: 'Data & charts',
    description: 'Monthly cloud cost breakdown',
    code: t`
pie showData
  title Cloud spend by service (USD / month)
  "Compute" : 4200
  "Database" : 2100
  "Storage" : 950
  "Networking" : 640
  "Monitoring" : 310
`,
  },
  {
    id: 'quadrant',
    name: 'Quadrant',
    group: 'Ideas & strategy',
    description: 'Feature prioritization: impact vs effort',
    code: t`
quadrantChart
  title Feature prioritization
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan carefully
  quadrant-2 Quick wins
  quadrant-3 Fill-ins
  quadrant-4 Avoid
  Dark mode: [0.25, 0.62]
  SSO login: [0.7, 0.85]
  CSV export: [0.18, 0.4]
  Offline mode: [0.88, 0.55]
  Onboarding tour: [0.35, 0.78]
  Custom themes: [0.62, 0.2]
`,
  },
  {
    id: 'requirement',
    name: 'Requirement',
    group: 'Software',
    description: 'Login requirements traced to design and tests',
    code: t`
requirementDiagram
  requirement secure_login {
    id: "REQ-1"
    text: Users must sign in with a password and a second factor
    risk: high
    verifymethod: test
  }
  functionalRequirement lockout {
    id: "REQ-1.1"
    text: Lock the account after 5 failed attempts
    risk: medium
    verifymethod: test
  }
  performanceRequirement fast_login {
    id: "REQ-2"
    text: Login completes in under 500 ms at p95
    risk: low
    verifymethod: analysis
  }
  element auth_service {
    type: service
    docref: docs/auth.md
  }
  element login_e2e {
    type: "e2e test suite"
  }
  secure_login - contains -> lockout
  auth_service - satisfies -> secure_login
  auth_service - satisfies -> fast_login
  login_e2e - verifies -> lockout
`,
  },
  {
    id: 'gitgraph',
    name: 'Git graph',
    group: 'Software',
    description: 'Feature branch workflow with a hotfix',
    code: t`
gitGraph
  commit id: "init"
  commit id: "add CI"
  branch develop
  checkout develop
  commit id: "api skeleton"
  branch feature/login
  checkout feature/login
  commit id: "login form"
  commit id: "session tokens"
  checkout develop
  merge feature/login
  checkout main
  branch hotfix
  commit id: "fix typo in footer"
  checkout main
  merge hotfix tag: "v1.0.1"
  checkout develop
  merge main
  commit id: "profile page"
  checkout main
  merge develop tag: "v1.1.0"
`,
  },
  {
    id: 'mindmap',
    name: 'Mind map',
    group: 'Ideas & strategy',
    description: 'Product launch brainstorm',
    code: t`
mindmap
  root((Product launch))
    Audience
      Early adopters
      Small agencies
      Students
    Channels
      Newsletter
      Product Hunt
      Partner blogs
    Messaging
      Privacy first
      Works offline
    Metrics
      Sign-ups
      Week-1 retention
      Referral rate
    Risks
      Server load
      Pricing confusion
`,
  },
  {
    id: 'timeline',
    name: 'Timeline',
    group: 'Planning',
    description: 'Product roadmap by quarter',
    code: t`
timeline
  title Product roadmap 2026
  section H1
    Q1 : Public beta : Billing v2
    Q2 : Mobile app : Team workspaces
  section H2
    Q3 : SSO and audit logs : EU data region
    Q4 : Marketplace launch : 1.0 release
`,
  },
  {
    id: 'sankey',
    name: 'Sankey',
    group: 'Data & charts',
    description: 'Website traffic to conversion flow',
    code: t`
sankey

Search,Landing page,4200
Social,Landing page,1800
Email,Pricing page,900
Landing page,Pricing page,2600
Landing page,Bounced,3400
Pricing page,Sign-up,1500
Pricing page,Bounced,2000
Sign-up,Paid plan,420
Sign-up,Free plan,1080
`,
  },
  {
    id: 'xychart',
    name: 'XY chart',
    group: 'Data & charts',
    description: 'Monthly revenue bars with a target line',
    code: t`
xychart
  title "Monthly revenue 2026 (k USD)"
  x-axis [Jan, Feb, Mar, Apr, May, Jun, Jul, Aug, Sep, Oct, Nov, Dec]
  y-axis "Revenue (k USD)" 0 --> 120
  bar [42, 48, 51, 58, 62, 70, 68, 75, 83, 90, 97, 110]
  line [45, 50, 55, 60, 65, 70, 75, 80, 85, 90, 95, 100]
`,
  },
  {
    id: 'block',
    name: 'Block',
    group: 'Software',
    description: 'Layered system architecture blocks',
    code: t`
block
  columns 3
  web["Web app"] mobile["Mobile app"] partner["Partner API"]
  space:3
  gateway["API gateway"]:3
  space:3
  auth["Auth service"] orders["Order service"] search["Search service"]
  db[("PostgreSQL")] queue[["Event queue"]] index[("Search index")]
  web --> gateway
  mobile --> gateway
  partner --> gateway
  gateway --> orders
  orders --> queue
`,
  },
  {
    id: 'packet',
    name: 'Packet',
    group: 'Software',
    description: 'TCP header layout',
    code: t`
packet
  title TCP header
  0-15: "Source port"
  16-31: "Destination port"
  32-63: "Sequence number"
  64-95: "Acknowledgment number"
  96-99: "Data offset"
  100-105: "Reserved"
  106-111: "Flags"
  112-127: "Window size"
  128-143: "Checksum"
  144-159: "Urgent pointer"
  160-191: "Options (variable)"
`,
  },
  {
    id: 'architecture',
    name: 'Architecture',
    group: 'Software',
    description: 'Cloud web app with groups and services',
    code: t`
architecture-beta
  group cloud(cloud)[Cloud account]
  group private(cloud)[Private subnet] in cloud

  service users(internet)[Users]
  service cdn(server)[CDN] in cloud
  service app(server)[App server] in private
  service db(database)[Postgres] in private
  service files(disk)[Object storage] in cloud

  users:R --> L:cdn
  cdn:R --> L:app
  app:R --> L:db
  app:B --> T:files
`,
  },
  {
    id: 'kanban',
    name: 'Kanban',
    group: 'Planning',
    description: 'Sprint board with tickets',
    code: t`
kanban
  todo[To do]
    t1[Write API docs]
    t2[Design empty states]@{ priority: 'Low' }
  doing[In progress]
    t3[Payment retries]@{ assigned: 'Sam', priority: 'High' }
    t4[Dark mode polish]
  review[In review]
    t5[Rate limiting middleware]@{ ticket: 'OPS-12' }
  done[Done]
    t6[Upgrade to Node 24]
`,
  },
  {
    id: 'radar',
    name: 'Radar',
    group: 'Data & charts',
    description: 'Comparing two laptops',
    code: t`
radar-beta
  title Laptop comparison
  axis perf["Performance"], battery["Battery"], screen["Screen"], weight["Portability"], price["Value"], ports["Ports"]
  curve a["Laptop A"]{8, 6, 9, 5, 4, 7}
  curve b["Laptop B"]{6, 9, 7, 9, 7, 4}
  max 10
  min 0
`,
  },
  {
    id: 'treemap',
    name: 'Treemap',
    group: 'Data & charts',
    description: 'Annual budget by department',
    code: t`
treemap-beta
"Engineering"
  "Salaries": 820
  "Cloud": 210
  "Tools": 60
"Marketing"
  "Ads": 180
  "Events": 90
  "Content": 45
"Operations"
  "Office": 120
  "Legal": 40
`,
  },
  {
    id: 'c4',
    name: 'C4 context',
    group: 'Software',
    description: 'System context for an internet bank',
    code: t`
C4Context
  title System context: online banking
  Person(customer, "Customer", "A retail bank customer")
  System(banking, "Online banking", "Lets customers view balances and make payments")
  System_Ext(mail, "Email service", "Sends notifications")
  System_Ext(core, "Core banking", "Accounts and transactions")
  Rel(customer, banking, "Uses", "HTTPS")
  Rel(banking, core, "Reads and writes", "REST")
  Rel(banking, mail, "Sends email via", "SMTP")
  Rel(mail, customer, "Emails")
`,
  },
  {
    id: 'swimlane',
    name: 'Swimlane',
    group: 'Process',
    beta: true,
    description: 'Hiring process across teams',
    code: t`
swimlane-beta LR
  subgraph candidate [Candidate]
    apply[Apply online]
    interview[Attend interview]
    accept[Accept offer]
  end
  subgraph recruiting [Recruiting]
    screen[Screen CV]
    schedule[Schedule interview]
    offer[Send offer]
  end
  subgraph team [Hiring team]
    decide{Hire?}
  end
  apply --> screen --> schedule --> interview --> decide
  decide -->|yes| offer --> accept
`,
  },
  {
    id: 'usecase',
    name: 'Use case',
    group: 'Software',
    beta: true,
    description: 'Actors and use cases of an online shop',
    code: t`
usecase-beta
  direction LR
  actor Customer
  actor Admin
  systemBoundary shop[Online shop]
    browse(Browse catalog)
    checkout(Check out)
    pay(Pay by card)
    manage(Manage products)
  end
  Customer --> browse
  Customer --> checkout
  checkout --> pay
  Admin --> manage
`,
  },
  {
    id: 'venn',
    name: 'Venn',
    group: 'Ideas & strategy',
    beta: true,
    description: 'Where product roles overlap',
    code: t`
venn-beta
  title Product team skills
  set design["Design"]
  set eng["Engineering"]
  set biz["Business"]
  union design,eng["Prototyping"]
  union eng,biz["Analytics"]
  union design,biz["Research"]
  union design,eng,biz["Product sense"]
`,
  },
  {
    id: 'ishikawa',
    name: 'Ishikawa (fishbone)',
    group: 'Ideas & strategy',
    beta: true,
    description: 'Root causes of checkout drop-off',
    code: t`
ishikawa-beta
  Checkout drop-off
    People
      Support replies slowly
      No live chat
    Process
      Mandatory account creation
      Long address form
    Technology
      Slow payment page
      Mobile layout bugs
    Pricing
      Surprise shipping fees
      Few payment options
`,
  },
  {
    id: 'treeview',
    name: 'Tree view',
    group: 'Software',
    beta: true,
    description: 'Project folder structure',
    code: t`
treeView-beta
  title my-app
  src
    components
      Button.tsx
      Header.tsx
    pages
      index.astro
    styles.css
  tests
    app.test.ts
  package.json
  README.md
`,
  },
  {
    id: 'wardley',
    name: 'Wardley map',
    group: 'Ideas & strategy',
    beta: true,
    description: 'Value chain for a tea shop',
    code: t`
wardley-beta
  title Tea shop
  anchor Business [0.95, 0.63]
  anchor Public [0.95, 0.78]
  component Cup of Tea [0.79, 0.61]
  component Cup [0.73, 0.78]
  component Tea [0.63, 0.81]
  component Hot Water [0.52, 0.80]
  component Water [0.38, 0.82]
  component Kettle [0.43, 0.35]
  component Power [0.10, 0.70]
  Business -> Cup of Tea
  Public -> Cup of Tea
  Cup of Tea -> Cup
  Cup of Tea -> Tea
  Cup of Tea -> Hot Water
  Hot Water -> Water
  Hot Water -> Kettle
  Kettle -> Power
  evolve Kettle 0.62
`,
  },
  {
    id: 'cynefin',
    name: 'Cynefin',
    group: 'Ideas & strategy',
    beta: true,
    description: 'Classifying work by how predictable it is',
    code: t`
cynefin-beta
  title Engineering work by domain
  clear
    "Rotate TLS certificates"
    "Apply security patches"
  complicated
    "Database performance tuning"
  complex
    "New product discovery"
  chaotic
    "Production outage"
  confusion
    "Unclear vendor contract"
  chaotic --> complex : "stabilize, then probe"
`,
  },
  {
    id: 'railroad',
    name: 'Railroad (EBNF)',
    group: 'Software',
    beta: true,
    description: 'Syntax diagram for a JSON value',
    code: t`
railroad-ebnf-beta
  title JSON value
  value = object | array | string | number | "true" | "false" | "null" ;
  object = "{" , [ member , { "," , member } ] , "}" ;
  member = string , ":" , value ;
  array = "[" , [ value , { "," , value } ] , "]" ;
`,
  },
  {
    id: 'eventmodeling',
    name: 'Event modeling',
    group: 'Software',
    beta: true,
    description: 'User registration slice',
    code: t`
eventmodeling
  tf 01 ui RegistrationForm
  tf 02 cmd RegisterUser ->> 01
  tf 03 evt UserRegistered ->> 02
  tf 04 rmo UserList ->> 03
  tf 05 pcr WelcomeEmailSender ->> 04
`,
  },
  {
    id: 'agentflow',
    name: 'Agent flow',
    group: 'Process',
    beta: true,
    description: 'AI agent that plans, calls tools and answers',
    code: t`
agentflow-beta LR
  question[User question]@{ shape: input }
  plan[Plan steps]@{ shape: task }
  search[Web search]@{ shape: tool }
  enough{Enough context?}@{ shape: decision }
  answer[Write answer]@{ shape: task }
  question --> plan --> search --> enough
  enough -->|no| plan
  enough -->|yes| answer
`,
  },
];

export const DEFAULT_TEMPLATE = TEMPLATES[0];
