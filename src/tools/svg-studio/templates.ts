// Template gallery: one realistic, ready-to-edit example per Mermaid diagram type.
// Every entry is rendered in tests/svg-studio.test.mjs, so keep them valid.

export interface Template {
  id: string;
  name: string;
  group: 'Process' | 'Software' | 'Data & charts' | 'Planning' | 'Ideas';
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
    id: 'mindmap',
    name: 'Mind map',
    group: 'Ideas',
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
];

export const DEFAULT_TEMPLATE = TEMPLATES[0];
