-- ============================================================
-- CLASSIFICAÇÃO DO EXTRATO — regras CONFIRMADAS pelo Rogério (16/06/2026)
-- COLE TUDO no SQL Editor do Supabase (projeto fimmjgdwhifsrrbreche) e RUN.
-- Idempotente: pode rodar mais de uma vez sem duplicar nada.
-- ============================================================

-- [já aplicadas via terminal — repetidas aqui só para o script ficar completo]
update public.fin_transacoes_bancarias
  set categoria='Taxa de ART (CREA)', tipo_categoria='Despesa'
where tipo='debito' and valor=108.39;

update public.fin_transacoes_bancarias
  set categoria='Receita de ART', tipo_categoria='Receita'
where tipo='credito' and valor=300.00;

-- ---- Regras confirmadas no chat (16/06/2026) ----

-- Cartão de crédito (parte do pró-labore) — débito em conta "DÉB.CONV"
update public.fin_transacoes_bancarias
  set categoria='Cartão de crédito', tipo_categoria='Despesa'
where tipo='debito' and historico ilike 'DÉB.CONV%';

-- Pró-labore — financiamento do veículo do Claudemir (boleto 1.985,81)
update public.fin_transacoes_bancarias
  set categoria='Pró-labore (financ. veículo)', tipo_categoria='Despesa'
where tipo='debito' and valor=1985.81;

-- Pró-labore Claudemir — PIX recorrente de 1.621,00
update public.fin_transacoes_bancarias
  set categoria='Pró-labore', tipo_categoria='Despesa'
where tipo='debito' and valor=1621.00 and historico ilike 'PIX%';

-- Tarifas bancárias — pacote de serviços / cesta / tarifas (texto do próprio banco)
update public.fin_transacoes_bancarias
  set categoria='Tarifas bancárias', tipo_categoria='Despesa'
where tipo='debito' and (valor=119.90 or historico ilike '%PACOTE SERVIÇOS%'
   or historico ilike 'TAR %' or historico ilike '%TARIFA%' or historico ilike '%CESTA%');

-- Impostos e Tributos — DAS/Simples/DARF/GPS/Receita Federal (texto do próprio banco)
update public.fin_transacoes_bancarias
  set categoria='Impostos e Tributos', tipo_categoria='Despesa'
where tipo='debito' and (historico ilike '%DAS%' or historico ilike '%SIMPLES%'
   or historico ilike '%DARF%' or historico ilike '%GPS%' or historico ilike '%RECEITA FEDERAL%');

-- ---- Resumo final: confira o resultado ----
select tipo_categoria, categoria, count(*) n, round(sum(valor),2) total
from public.fin_transacoes_bancarias
group by tipo_categoria, categoria
order by tipo_categoria, sum(valor) desc;
