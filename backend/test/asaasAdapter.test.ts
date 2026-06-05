import { describe, it, expect, afterEach } from 'vitest';
import { AsaasAdapter } from '../src/billing/adapters/AsaasAdapter';

const a = new AsaasAdapter('fake_key');

describe('AsaasAdapter.normalizarWebhook', () => {
  it('mapeia PAYMENT_CONFIRMED e usa externalReference como faturaId local', () => {
    const ev = a.normalizarWebhook(JSON.stringify({
      id: 'evt_1', event: 'PAYMENT_CONFIRMED',
      payment: { id: 'pay_1', externalReference: 'fat-abc', value: 299, subscription: 'sub_9', paymentDate: '2026-05-10' },
    }));
    expect(ev.eventType).toBe('payment.confirmed');
    expect(ev.gatewayFaturaId).toBe('fat-abc');
    expect(ev.gatewaySubscriptionId).toBe('sub_9');
    expect(ev.valor).toBe(299);
    expect(ev.gatewayEventId).toBe('evt_1');
  });

  it('mapeia variantes de evento da Asaas para o vocabulário canônico', () => {
    const m = (e: string) => a.normalizarWebhook(JSON.stringify({ event: e, payment: { id: 'p' } })).eventType;
    expect(m('PAYMENT_RECEIVED')).toBe('payment.confirmed');
    expect(m('PAYMENT_OVERDUE')).toBe('payment.overdue');
    expect(m('PAYMENT_REFUNDED')).toBe('payment.refunded');
    expect(m('PAYMENT_DELETED')).toBe('payment.failed');
    expect(m('SUBSCRIPTION_DELETED')).toBe('subscription.deleted');
  });

  it('sintetiza um eventId estável quando a Asaas não envia id (idempotência)', () => {
    const ev = a.normalizarWebhook(JSON.stringify({ event: 'PAYMENT_RECEIVED', payment: { id: 'pay_42' } }));
    expect(ev.gatewayEventId).toBe('PAYMENT_RECEIVED_pay_42');
  });

  it('cai para o id do pagamento quando não há externalReference', () => {
    const ev = a.normalizarWebhook(JSON.stringify({ event: 'PAYMENT_CONFIRMED', payment: { id: 'pay_only' } }));
    expect(ev.gatewayFaturaId).toBe('pay_only');
  });
});

describe('AsaasAdapter.validarAssinatura (token de webhook, fail-closed)', () => {
  const ORIGINAL = process.env.ASAAS_WEBHOOK_TOKEN;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ASAAS_WEBHOOK_TOKEN;
    else process.env.ASAAS_WEBHOOK_TOKEN = ORIGINAL;
  });

  it('aceita o token correto', () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'sekret';
    expect(a.validarAssinatura('{}', { 'asaas-access-token': 'sekret' })).toBe(true);
  });
  it('aceita header em forma de array', () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'sekret';
    expect(a.validarAssinatura('{}', { 'asaas-access-token': ['sekret'] })).toBe(true);
  });
  it('rejeita token incorreto', () => {
    process.env.ASAAS_WEBHOOK_TOKEN = 'sekret';
    expect(a.validarAssinatura('{}', { 'asaas-access-token': 'errado' })).toBe(false);
  });
  it('rejeita quando não há token configurado (fail-closed)', () => {
    delete process.env.ASAAS_WEBHOOK_TOKEN;
    expect(a.validarAssinatura('{}', { 'asaas-access-token': 'qualquer' })).toBe(false);
  });
});
