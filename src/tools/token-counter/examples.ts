// Sample inputs that show how token efficiency varies by content type.
export const EXAMPLES: { key: string; label: string; text: string }[] = [
  {
    key: 'prose',
    label: 'English prose',
    text: `Language models do not read letters or words. They read tokens: chunks of text that a tokenizer learned from a large corpus. Common English words are usually a single token, while rare words, names and typos get split into several pieces.

That is why a page of plain English often averages about four characters per token, and why the same idea written in another language, in code, or with lots of emoji can cost noticeably more.`,
  },
  {
    key: 'code',
    label: 'Code',
    text: `export async function fetchUsers(ids: number[]): Promise<User[]> {
  const results: User[] = [];
  for (const id of ids) {
    const res = await db.query('SELECT * FROM users WHERE id = $1', [id]);
    if (res.rows.length > 0) {
      results.push(mapRow(res.rows[0]));
    }
  }
  return results.sort((a, b) => a.name.localeCompare(b.name));
}
`,
  },
  {
    key: 'json',
    label: 'JSON',
    text: `{
  "id": "ord_8f2a91c4",
  "status": "shipped",
  "items": [
    { "sku": "TSHIRT-BLK-M", "qty": 2, "price": 19.99 },
    { "sku": "MUG-WHT-350", "qty": 1, "price": 12.5 }
  ],
  "customer": { "name": "Ada Lovelace", "email": "ada@example.com" },
  "createdAt": "2025-03-14T09:26:53Z"
}
`,
  },
  {
    key: 'multilingual',
    label: 'Multilingual',
    text: `English: The weather is lovely today, let's go for a walk.
Español: Hoy hace un tiempo precioso, vamos a dar un paseo.
Deutsch: Das Wetter ist heute herrlich, lass uns spazieren gehen.
Русский: Сегодня прекрасная погода, давай пойдём гулять.
日本語: 今日はとても良い天気なので、散歩に行きましょう。
中文: 今天天气很好，我们去散步吧。
हिन्दी: आज मौसम बहुत अच्छा है, चलो टहलने चलते हैं।
العربية: الطقس جميل اليوم، هيا نذهب في نزهة.`,
  },
  {
    key: 'emoji',
    label: 'Emoji',
    text: `Launch day! 🚀🎉 Thanks team 🙏💜
Weather: ☀️ → 🌧️ → 🌈
Family: 👨‍👩‍👧‍👦  Skin tones: 👍🏻 👍🏽 👍🏿  Flags: 🇯🇵 🇧🇷 🇨🇦
Faces: 😀😃😄😁😆😅🤣😂🙂🙃`,
  },
];
