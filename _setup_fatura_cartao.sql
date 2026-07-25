-- ══════════════════════════════════════════════════════════════
-- Diagnóstika — Importação de Fatura de Cartão de Crédito
-- Tabelas: fin_servicos_empresa, fin_faturas_cartao, fin_fatura_itens
-- ══════════════════════════════════════════════════════════════

-- 1) Serviços digitais reconhecidos da empresa
CREATE TABLE IF NOT EXISTS fin_servicos_empresa (
  id          BIGSERIAL PRIMARY KEY,
  nome        TEXT NOT NULL,
  palavras_chave TEXT[] NOT NULL DEFAULT '{}',
  categoria   TEXT NOT NULL DEFAULT 'Outros',
  ativo       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO fin_servicos_empresa (nome, palavras_chave, categoria) VALUES
  ('Anthropic (Claude)',    ARRAY['ANTHROPIC','CLAUDE'],                             'IA'),
  ('OpenAI (ChatGPT/API)', ARRAY['OPENAI','CHATGPT'],                               'IA'),
  ('Google (Gemini/Cloud)', ARRAY['GOOGLE','GEMINI','GOOGLE*CLOUD','GOOGLE *CLOUD'], 'IA / Cloud'),
  ('Supabase',              ARRAY['SUPABASE'],                                       'Infraestrutura'),
  ('GitHub',                ARRAY['GITHUB','MICROSOFT*GITHUB'],                      'Infraestrutura'),
  ('Contabo (VPS)',         ARRAY['CONTABO'],                                        'Infraestrutura'),
  ('MegaZap',               ARRAY['MEGAZAP','MZAP'],                                 'Comunicação'),
  ('DocuSign',              ARRAY['DOCUSIGN'],                                       'Ferramentas'),
  ('Registro.br',           ARRAY['REGISTRO.BR'],                                    'Infraestrutura'),
  ('Cloudflare',            ARRAY['CLOUDFLARE'],                                     'Infraestrutura'),
  ('GoDaddy',               ARRAY['GODADDY'],                                        'Infraestrutura'),
  ('Canva',                 ARRAY['CANVA'],                                          'Marketing'),
  ('Certisign',             ARRAY['CERTISIGN'],                                      'Certificação'),
  ('Serasa (Certificado)',  ARRAY['SERASA'],                                         'Certificação'),
  ('Valid (Certificado)',   ARRAY['VALID CERTIFICADORA'],                             'Certificação'),
  ('SafeWeb',               ARRAY['SAFEWEB'],                                        'Certificação'),
  ('Microsoft 365',         ARRAY['MICROSOFT*365','MSFT*365','MICROSOFT 365'],       'Ferramentas'),
  ('Zoom',                  ARRAY['ZOOM','ZOOM.US','ZOOM VIDEO'],                    'Comunicação'),
  ('Hetzner',               ARRAY['HETZNER'],                                        'Infraestrutura'),
  ('Vercel',                ARRAY['VERCEL'],                                         'Infraestrutura'),
  ('Hostinger',             ARRAY['HOSTINGER'],                                      'Infraestrutura')
ON CONFLICT DO NOTHING;

-- 2) Faturas de cartão importadas
CREATE TABLE IF NOT EXISTS fin_faturas_cartao (
  id                       BIGSERIAL PRIMARY KEY,
  competencia              TEXT NOT NULL,
  arquivo_nome             TEXT,
  total_fatura_centavos    BIGINT NOT NULL DEFAULT 0,
  total_reembolso_centavos BIGINT NOT NULL DEFAULT 0,
  data_import              TIMESTAMPTZ DEFAULT NOW(),
  hash                     TEXT UNIQUE NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado'))
);

-- 3) Itens de cada fatura
CREATE TABLE IF NOT EXISTS fin_fatura_itens (
  id              BIGSERIAL PRIMARY KEY,
  fatura_id       BIGINT NOT NULL REFERENCES fin_faturas_cartao(id) ON DELETE CASCADE,
  data            DATE,
  descricao       TEXT NOT NULL,
  valor_centavos  BIGINT NOT NULL,
  servico_id      BIGINT REFERENCES fin_servicos_empresa(id),
  reembolsavel    BOOLEAN NOT NULL DEFAULT FALSE,
  editado_manual  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_fatura_itens_fatura ON fin_fatura_itens(fatura_id);
CREATE INDEX IF NOT EXISTS idx_faturas_hash ON fin_faturas_cartao(hash);
CREATE INDEX IF NOT EXISTS idx_faturas_status ON fin_faturas_cartao(status);

ALTER TABLE fin_servicos_empresa ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_faturas_cartao ENABLE ROW LEVEL SECURITY;
ALTER TABLE fin_fatura_itens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "fin_servicos_empresa_all" ON fin_servicos_empresa FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "fin_faturas_cartao_all" ON fin_faturas_cartao FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "fin_fatura_itens_all" ON fin_fatura_itens FOR ALL USING (true) WITH CHECK (true);

-- 4) GRANTs — sem isto dá "permission denied for table" mesmo com RLS liberado.
--    (RLS controla LINHAS; GRANT controla acesso à TABELA. Precisa dos dois.)
GRANT SELECT, INSERT, UPDATE, DELETE ON fin_servicos_empresa, fin_faturas_cartao, fin_fatura_itens TO authenticated, anon;
GRANT USAGE, SELECT ON SEQUENCE fin_servicos_empresa_id_seq, fin_faturas_cartao_id_seq, fin_fatura_itens_id_seq TO authenticated, anon;
