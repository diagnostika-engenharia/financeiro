-- ============================================================
-- CLASSIFICAÇÃO DO EXTRATO — 6 meses (jan–jun/2026)
-- Fonte: comprovantes do grupo WhatsApp "Financeiro Diagnóstika"
-- (lidos via Evolution API em 16/06/2026) + reconciliação dos
-- relatórios de pró-labore/reembolso/cofre.
--
-- Estratégia: valores recorrentes mapeiam categorias fixas,
-- confirmados pelos comprovantes:
--   R$ 108,39  (40x) = Anuidade/ART CREA   (dezenas de "Art X" no grupo)
--   R$ 1.621,00 PIX (5x) = Pró-labore Claudemir (parcela depósito)
--   R$ 1.985,81 boleto (4x) = Financ. veículo Claudemir (pró-labore)
--   R$ 318,21  = Contabilidade Veiga/Zicami
--   R$ 237,58  = Cartório (Reg. Imóveis Hortolândia)
--   R$ 119,90  (6x) = Tarifa pacote de serviços (banco)
--   DÉB.CONV.DEM.EMPRES ~1.994 = Cartão de crédito (pró-labore)
-- Idempotente (UPDATE por critério). Não cria duplicatas.
-- ============================================================

-- Taxa de ART paga ao CREA — valor fixo nacional 108,39 (sempre débito PIX)
-- (regra confirmada pelo usuário 16/06/2026: "108,39 é taxa de ART que pagamos pro CREA")
update public.fin_transacoes_bancarias
set categoria='Taxa de ART (CREA)', tipo_categoria='Despesa'
where tipo='debito' and valor=108.39;

-- Receita de ART — PIX recebido de 300,00 (cobrança da ART ao cliente/projeto)
-- (regra confirmada pelo usuário 16/06/2026: "pix de crédito de 300,00 pode classificar como ART")
update public.fin_transacoes_bancarias
set categoria='Receita de ART', tipo_categoria='Receita'
where tipo='credito' and valor=300.00;

-- Pró-labore Claudemir — PIX recorrente de 1.621,00
update public.fin_transacoes_bancarias
set categoria='Pró-labore', tipo_categoria='Despesa'
where tipo='debito' and valor=1621.00 and historico ilike 'PIX%';

-- Financiamento do veículo (parte do pró-labore Claudemir) — boleto 1.985,81
update public.fin_transacoes_bancarias
set categoria='Pró-labore (financ. veículo)', tipo_categoria='Despesa'
where tipo='debito' and valor=1985.81;

-- Cartão de crédito (parte do pró-labore) — débito em conta DÉB.CONV
update public.fin_transacoes_bancarias
set categoria='Cartão de crédito', tipo_categoria='Despesa'
where tipo='debito' and historico ilike 'DÉB.CONV%';

-- Tarifa de pacote de serviços bancários — 119,90
update public.fin_transacoes_bancarias
set categoria='Tarifas bancárias', tipo_categoria='Despesa'
where tipo='debito' and (valor=119.90 or historico ilike '%PACOTE SERVIÇOS%');

-- Tarifas / cestas / outras tarifas bancárias
update public.fin_transacoes_bancarias
set categoria='Tarifas bancárias', tipo_categoria='Despesa'
where tipo='debito' and (historico ilike 'TAR %' or historico ilike '%TARIFA%' or historico ilike '%CESTA%');

-- Impostos e tributos (DAS/Simples/DARF/GPS/Receita Federal)
update public.fin_transacoes_bancarias
set categoria='Impostos e Tributos', tipo_categoria='Despesa'
where tipo='debito' and (historico ilike '%DAS%' or historico ilike '%SIMPLES%'
   or historico ilike '%DARF%' or historico ilike '%GPS%' or historico ilike '%RECEITA FEDERAL%');

-- ---- Descrições ricas por hash (junho, confirmadas por imagem) ----
update public.fin_transacoes_bancarias set descricao='Contabilidade Veiga — R.Postal Serviços Contábeis', historico='Contabilidade Veiga — R.Postal Serviços Contábeis', categoria='Contabilidade', tipo_categoria='Despesa' where hash='sic9d800b82';
update public.fin_transacoes_bancarias set descricao='Cartório — Reg. Imóveis Hortolândia (matrículas/averbação AA-27/AA-28)', historico='Cartório — Reg. Imóveis Hortolândia', categoria='Cartório e Taxas', tipo_categoria='Despesa' where hash='sic336f2783';
update public.fin_transacoes_bancarias set descricao='ART/CREA — Proj A35 Gisele/Lucas', historico='ART/CREA — Proj A35 Gisele/Lucas' where hash='sic2e8f3c83';
update public.fin_transacoes_bancarias set descricao='ART/CREA — Morador Cond. União (Breno)', historico='ART/CREA — Morador Cond. União (Breno)' where hash='sic89a91049';
update public.fin_transacoes_bancarias set descricao='Pró-labore Claudemir (parcela depósito)', historico='Pró-labore Claudemir' where hash='sic47f19c18';
update public.fin_transacoes_bancarias set descricao='Cadista Marcus — Proj Lucas', historico='Cadista Marcus — Proj Lucas', categoria='Serviços de Terceiros (Projetos)', tipo_categoria='Despesa' where hash='sicf9477147';
update public.fin_transacoes_bancarias set descricao='Cadista Marcus — Ajuste Proj Rodrigo', historico='Cadista Marcus — Ajuste Proj Rodrigo', categoria='Serviços de Terceiros (Projetos)', tipo_categoria='Despesa' where hash='sic9fd51d59';
update public.fin_transacoes_bancarias set descricao='Sinal projeto Lucas/Giselle (Milton Turquetti)', historico='Sinal projeto Lucas/Giselle', categoria='Receita de Projetos', tipo_categoria='Receita' where hash='sic233e0d88';

-- Categoria padrão para o que sobrou (PIX sem comprovante): marca como "A classificar"
-- (mantém genérico, não inventa) — só para créditos/débitos ainda em rótulo cru.
update public.fin_transacoes_bancarias
set categoria='A classificar'
where categoria in ('Pagamento PIX','Recebimento PIX','Não classificado') and tipo='debito';
update public.fin_transacoes_bancarias
set categoria='Recebimentos a identificar'
where categoria in ('Recebimento PIX','Não classificado') and tipo='credito';

-- Resumo final por categoria (despesas)
select tipo_categoria, categoria, count(*) n, round(sum(valor),2) total
from public.fin_transacoes_bancarias
group by tipo_categoria, categoria
order by tipo_categoria, sum(valor) desc;
