
describe('cachedSource', () => {
  it('serve do cache dentro do TTL e revalida depois', async () => {
    let clock = 0;
    let calls = 0;
    const source = cachedSource(
      async () => {
        calls++;
        return [calls];
      },
      60_000,
      () => clock,
    );

    expect(await source()).toEqual([1]);
    clock = 15_000;
    expect(await source()).toEqual([1]); // dentro do TTL: não chama de novo
    clock = 45_000;
    expect(await source()).toEqual([1]);
    expect(calls).toBe(1);

    clock = 61_000;
    expect(await source()).toEqual([2]); // TTL vencido: revalida
    expect(calls).toBe(2);
  });

  it('em falha, serve o resultado anterior (até 5×TTL) em vez de derrubar a descoberta', async () => {
    let clock = 0;
    let fail = false;
    const source = cachedSource(
      async () => {
        if (fail) throw new Error('429');
        return ['ok'];
      },
      60_000,
      () => clock,
    );

    expect(await source()).toEqual(['ok']);
    fail = true;
    clock = 61_000;
    expect(await source()).toEqual(['ok']); // stale é melhor que nada
    clock = 400_000; // além de 5×TTL: o erro passa a propagar
    await expect(source()).rejects.toThrow('429');
  });

  it('ttl 0 desliga o cache', async () => {
    let calls = 0;
    const source = cachedSource(
      async () => {
        calls++;
        return [calls];
      },
      0,
      () => 0,
    );
    await source();
    await source();
    expect(calls).toBe(2);
  });
});
