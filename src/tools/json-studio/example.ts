// The document shown on first load: a realistic API response with nesting, nulls, booleans,
// numbers, empty and non-empty arrays, an optional field and keys that need bracket notation.
export const EXAMPLE = {
  status: 'ok',
  requestId: 'req_7f3a9c21',
  generatedAt: '2026-11-24T09:15:00Z',
  pagination: { page: 1, perPage: 3, total: 3, next: null },
  users: [
    {
      id: 101,
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      active: true,
      'last login': '2026-11-23T18:42:11Z',
      roles: ['admin', 'editor'],
      address: { street: '12 St James Square', city: 'London', postcode: 'SW1Y 4LB', geo: { lat: 51.5074, lng: -0.1361 } },
      orders: [
        {
          id: 'ord_1001',
          total: 42.5,
          currency: 'EUR',
          paid: true,
          items: [
            { sku: 'BK-ANALYT', title: 'Notes on the Analytical Engine', qty: 1, price: 29.5 },
            { sku: 'PN-BRASS', title: 'Brass fountain pen', qty: 2, price: 6.5 },
          ],
          shippedAt: '2026-11-02T14:00:00Z',
        },
      ],
    },
    {
      id: 102,
      name: 'Alan Turing',
      email: null,
      active: false,
      'last login': null,
      roles: [],
      address: null,
      orders: [],
    },
    {
      id: 103,
      name: 'Grace Hopper',
      email: 'grace@example.com',
      active: true,
      'last login': '2026-11-24T07:03:54Z',
      roles: ['editor'],
      address: { street: '1 Navy Way', city: 'Arlington', postcode: 'VA 22201', geo: { lat: 38.8816, lng: -77.091 } },
      orders: [
        { id: 'ord_1002', total: 18, currency: 'USD', paid: false, items: [{ sku: 'MUG-COBOL', title: 'COBOL mug', qty: 1, price: 18 }], shippedAt: null },
      ],
      nickname: 'Amazing Grace',
    },
  ],
  meta: {
    'api version': '2.4.1',
    'rate-limit': { limit: 1000, remaining: 997, resetsIn: 3600 },
    features: { beta: false, darkMode: true },
    tags: ['production', 'eu-west-1'],
  },
};

export const EXAMPLE_TEXT = JSON.stringify(EXAMPLE, null, 2);
