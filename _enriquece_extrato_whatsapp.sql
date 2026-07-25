-- ============================================================
-- ENRIQUECIMENTO do extrato a partir dos COMPROVANTES do grupo
-- WhatsApp "Financeiro Diagnóstika" (lidos via Evolution API,
-- modo só-leitura, em 16/06/2026).
--
-- O grupo NÃO traz transações novas: todos os comprovantes são
-- da própria conta Sicoob/CC Crediter (862.325-2) e JÁ ESTÃO em
-- fin_transacoes_bancarias como linhas genéricas
-- "PIX EMIT.OUTRA IF / Pagamento PIX". O que faltava era saber
-- O QUE era cada PIX. Este script preenche descrição + categoria
-- contábil correta em cada hash, casando comprovante↔extrato por
-- valor+data (junho/2026).
--
-- Idempotente: UPDATE por hash. Rode no SQL Editor ou via pooler.
-- ============================================================

-- 1) Despesas (PIX emitidos) — descrição e categoria reais
update public.fin_transacoes_bancarias set
  descricao='Contabilidade Veiga — R.Postal Serviços Contábeis', historico=descricao,
  categoria='Contabilidade', tipo_categoria='Despesa'
where hash='sic9d800b82';                                  -- 02/06  R$ 318,21

update public.fin_transacoes_bancarias set
  descricao='Cartório — Reg. Imóveis Hortolândia (matrículas/averbação AA-27/AA-28)', historico=descricao,
  categoria='Cartório e Taxas', tipo_categoria='Despesa'
where hash='sic336f2783';                                  -- 09/06  R$ 237,58

update public.fin_transacoes_bancarias set
  descricao='ART/CREA — Proj A35 Gisele/Lucas', historico=descricao,
  categoria='Anuidades e ART (CREA)', tipo_categoria='Despesa'
where hash='sic2e8f3c83';                                  -- 09/06  R$ 108,39

update public.fin_transacoes_bancarias set
  descricao='ART/CREA — Morador Cond. União (Breno)', historico=descricao,
  categoria='Anuidades e ART (CREA)', tipo_categoria='Despesa'
where hash='sic89a91049';                                  -- 03/06  R$ 108,39

update public.fin_transacoes_bancarias set
  descricao='Pró-labore Claudemir', historico=descricao,
  categoria='Pró-labore', tipo_categoria='Despesa'
where hash='sic47f19c18';                                  -- 10/06  R$ 1.621,00

update public.fin_transacoes_bancarias set
  descricao='Cadista Marcus — Proj Lucas', historico=descricao,
  categoria='Serviços de Terceiros (Projetos)', tipo_categoria='Despesa'
where hash='sicf9477147';                                  -- 15/06  R$ 125,00

update public.fin_transacoes_bancarias set
  descricao='Cadista Marcus — Ajuste Proj Rodrigo', historico=descricao,
  categoria='Serviços de Terceiros (Projetos)', tipo_categoria='Despesa'
where hash='sic9fd51d59';                                  -- 15/06  R$ 80,00

-- 2) Receita (PIX recebido) — sinal de projeto
update public.fin_transacoes_bancarias set
  descricao='Sinal projeto Lucas/Giselle (Milton Turquetti)', historico=descricao,
  categoria='Receita de Projetos', tipo_categoria='Receita'
where hash='sic233e0d88';                                  -- 08/06  R$ 1.500,00

select 'OK — '||count(*)||' lançamentos enriquecidos a partir dos comprovantes do WhatsApp' as resultado
from public.fin_transacoes_bancarias
where hash in ('sic9d800b82','sic336f2783','sic2e8f3c83','sic89a91049',
               'sic47f19c18','sicf9477147','sic9fd51d59','sic233e0d88')
  and categoria not in ('Pagamento PIX','Recebimento PIX','Não classificado');
