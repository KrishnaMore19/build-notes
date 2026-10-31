// Fires many concurrent requests at each endpoint and prints the result.
const BASE = "http://localhost:3000";
const N = 50;

const post = (path, headers = {}) =>
  fetch(BASE + path, { method: "POST", headers });

async function reset() {
  await fetch(BASE + "/reset", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ stock: 1 }),
  });
}

async function testBuy(name, path) {
  await reset();
  const results = await Promise.all(Array.from({ length: N }, () => post(path)));
  const success = results.filter((r) => r.status === 200).length;
  const { stock } = await (await fetch(BASE + "/stock")).json();
  const verdict = success === 1 ? "OK " : "BUG";
  console.log(
    `${verdict} ${name.padEnd(18)} stock=1, ${N} requests -> ${success} succeeded (final stock: ${stock})`
  );
}

async function counts() {
  const { orders } = await (await fetch(BASE + "/orders/count")).json();
  const { stock } = await (await fetch(BASE + "/stock")).json();
  return { orders, stock };
}

// Same request sent 10 times with the SAME key -> must create 1 order
async function testIdempotencySameKey() {
  await reset();
  const headers = { "Idempotency-Key": "order-abc-123" };
  await Promise.all(Array.from({ length: 10 }, () => post("/order", headers)));
  const { orders, stock } = await counts();
  const verdict = orders === 1 && stock === 0 ? "OK " : "BUG";
  console.log(`${verdict} ${"idempotency: same key".padEnd(22)} 10 identical requests -> ${orders} order(s), stock ${stock}`);
}

// 10 DIFFERENT customers (different keys), stock=1 -> must still create 1 order
// (idempotency alone doesn't stop overselling; the atomic stock update does)
async function testIdempotencyDifferentKeys() {
  await reset();
  await Promise.all(
    Array.from({ length: 10 }, (_, i) => post("/order", { "Idempotency-Key": `customer-${i}` }))
  );
  const { orders, stock } = await counts();
  const verdict = orders === 1 && stock === 0 ? "OK " : "BUG";
  console.log(`${verdict} ${"idempotency: diff keys".padEnd(22)} 10 customers, stock=1 -> ${orders} order(s), stock ${stock}`);
}

console.log("Expected: exactly 1 success per endpoint (only 1 item in stock)\n");
await testBuy("unsafe (the bug)", "/buy-unsafe");
await testBuy("fix 1: atomic", "/buy-atomic");
await testBuy("fix 2: FOR UPDATE", "/buy-lock");
await testBuy("fix 3: optimistic", "/buy-optimistic");
await testIdempotencySameKey();
await testIdempotencyDifferentKeys();