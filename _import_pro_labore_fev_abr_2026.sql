-- ══════════════════════════════════════════════════
-- Importação Pró-Labore: Fev, Mar, Abr/2026
-- Ambos os sócios — Status: Pago
-- ══════════════════════════════════════════════════

-- IDs dos sócios
-- Rogério:   bc85944b-5b89-4710-886c-1717e8309e24
-- Claudemir: a71d23f8-0b1f-4dc5-ae44-829a5c1073a3

BEGIN;

-- ─── CLAUDEMIR Fev/2026 (Nr 202446) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('a71d23f8-0b1f-4dc5-ae44-829a5c1073a3', 'Claudemir Scaranello', '2026-02', 750000, 'Pago', '2026-03-25', '2026-03-25', 'Espécie', '202446', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 02/2026', 750000, '2026-03-25'),
  ((SELECT id FROM pl), 'debito', 'Depósito em conta', 162100, '2026-03-10'),
  ((SELECT id FROM pl), 'debito', 'Cartão de crédito', 240641, '2026-03-19'),
  ((SELECT id FROM pl), 'debito', 'Financiamento carro', 198581, '2026-03-23');

-- ─── CLAUDEMIR Mar/2026 (Nr 202448) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('a71d23f8-0b1f-4dc5-ae44-829a5c1073a3', 'Claudemir Scaranello', '2026-03', 750000, 'Pago', '2026-04-20', '2026-04-21', 'Espécie', '202448', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 03/2026', 750000, '2026-04-20'),
  ((SELECT id FROM pl), 'debito', 'Depósito em conta', 162100, '2026-04-10'),
  ((SELECT id FROM pl), 'debito', 'Cartão de crédito', 295711, '2026-04-20'),
  ((SELECT id FROM pl), 'debito', 'Financiamento carro', 198581, '2026-04-23');

-- ─── CLAUDEMIR Abr/2026 (Nr 202450) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('a71d23f8-0b1f-4dc5-ae44-829a5c1073a3', 'Claudemir Scaranello', '2026-04', 750000, 'Pago', '2026-05-22', '2026-05-22', 'Espécie', '202450', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 04/2026', 750000, '2026-05-22'),
  ((SELECT id FROM pl), 'debito', 'Depósito em conta', 162100, '2026-05-10'),
  ((SELECT id FROM pl), 'debito', 'Cartão de crédito', 192429, '2026-05-20'),
  ((SELECT id FROM pl), 'debito', 'Financiamento carro', 198581, '2026-05-23');

-- ─── ROGÉRIO Fev/2026 (Nr 202447) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('bc85944b-5b89-4710-886c-1717e8309e24', 'Rogério Conceição', '2026-02', 750000, 'Pago', '2026-03-25', '2026-03-25', 'Pix', '202447', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 02/2026', 750000, '2026-03-25'),
  ((SELECT id FROM pl), 'debito', 'Pagamento Cartão', 364199, '2026-03-12');

-- ─── ROGÉRIO Mar/2026 (Nr 202449) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('bc85944b-5b89-4710-886c-1717e8309e24', 'Rogério Conceição', '2026-03', 750000, 'Pago', '2026-04-20', '2026-04-20', 'Pix', '202449', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 03/2026', 750000, '2026-04-20'),
  ((SELECT id FROM pl), 'debito', 'Pagamento Cartão', 106598, '2026-04-14'),
  ((SELECT id FROM pl), 'debito', 'Adiantamento', 50000, '2026-04-20');

-- ─── ROGÉRIO Abr/2026 (Nr 202451) ───
WITH pl AS (
  INSERT INTO fin_pro_labore (socio_id, socio_nome, competencia, valor_bruto, status, data_aprovacao, data_pagamento, forma_pagamento, nr_controle, observacao)
  VALUES ('bc85944b-5b89-4710-886c-1717e8309e24', 'Rogério Conceição', '2026-04', 750000, 'Pago', '2026-05-22', '2026-05-22', 'Pix', '202451', 'Importado da planilha Excel')
  RETURNING id
)
INSERT INTO fin_pro_labore_itens (pro_labore_id, tipo, descricao, valor, data) VALUES
  ((SELECT id FROM pl), 'credito', 'Pró labore ref 04/2026', 750000, '2026-05-22'),
  ((SELECT id FROM pl), 'debito', 'Adiantamento depósito Luis', 200000, '2026-05-06');

-- Atualizar sequência de nr_controle
SELECT setval('fin_pro_labore_nr_seq', 202451);

COMMIT;

-- Verificar resultado
SELECT id, socio_nome, competencia, valor_bruto/100.0 as bruto, status, nr_controle
FROM fin_pro_labore ORDER BY competencia, socio_nome;
