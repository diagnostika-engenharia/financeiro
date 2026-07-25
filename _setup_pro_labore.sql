-- ════════════════════════════════════════════════════════════
-- Módulo Pró-Labore — tabelas
-- ════════════════════════════════════════════════════════════

-- Relatórios mensais de pró-labore por sócio
CREATE TABLE IF NOT EXISTS fin_pro_labore (
  id            SERIAL PRIMARY KEY,
  socio_id      UUID NOT NULL,
  socio_nome    VARCHAR(100) NOT NULL,
  competencia   VARCHAR(7) NOT NULL,          -- YYYY-MM
  valor_bruto   INTEGER NOT NULL DEFAULT 0,   -- centavos
  status        VARCHAR(20) NOT NULL DEFAULT 'Rascunho',
  -- status: Rascunho | Aprovado | Pago | Estornado
  data_aprovacao DATE,
  data_pagamento DATE,
  forma_pagamento VARCHAR(30),                -- Pix | Espécie | Transferência
  nr_controle   VARCHAR(20),
  observacao    TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(socio_id, competencia, nr_controle)
);

-- Itens (linhas) de cada relatório: créditos e débitos
CREATE TABLE IF NOT EXISTS fin_pro_labore_itens (
  id            SERIAL PRIMARY KEY,
  pro_labore_id INTEGER NOT NULL REFERENCES fin_pro_labore(id) ON DELETE CASCADE,
  tipo          VARCHAR(10) NOT NULL,         -- credito | debito
  descricao     VARCHAR(200) NOT NULL,
  valor         INTEGER NOT NULL DEFAULT 0,   -- centavos (sempre positivo)
  data          DATE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_pl_socio ON fin_pro_labore(socio_id);
CREATE INDEX IF NOT EXISTS idx_pl_comp ON fin_pro_labore(competencia);
CREATE INDEX IF NOT EXISTS idx_pl_itens_pl ON fin_pro_labore_itens(pro_labore_id);

-- RLS
ALTER TABLE fin_pro_labore ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_pro_labore_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "auth_read_pl" ON fin_pro_labore FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_write_pl" ON fin_pro_labore FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "auth_read_pli" ON fin_pro_labore_itens FOR SELECT TO authenticated USING (true);
CREATE POLICY "auth_write_pli" ON fin_pro_labore_itens FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Sequência para número de controle
CREATE SEQUENCE IF NOT EXISTS fin_pro_labore_nr_seq START 202452;
