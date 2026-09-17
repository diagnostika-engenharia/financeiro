-- ============================================================
-- Financeiro Diagnóstika — Plano de consistência, etapa 3
-- Migração: trilha de origem/inferência/evidência no livro razão
-- Rodar UMA vez no SQL Editor do Supabase (projeto fimmjgdwhifsrrbreche).
-- Idempotente: pode rodar de novo sem efeito colateral.
-- 17/09/2026
-- ============================================================

-- 1) Origem da regra que classificou a linha e estado da inferência
--    origem_regra: 'sync' | 'app' | 'app_prolabore' | 'parcelamento' | 'inferencia_carro' | 'recibo_grupo' | 'manual'
--    status_inferencia: null (não inferida) | 'sugerida' | 'confirmada' | 'rejeitada'
alter table public.fin_transacoes_bancarias
  add column if not exists origem_regra      text,
  add column if not exists status_inferencia text,
  add column if not exists evidencia_msg_id  text,   -- id da mensagem (mensagens_wa) que comprova a classificação
  add column if not exists evidencia_url     text;   -- link do recibo/arquivo, quando houver

alter table public.fin_livro_caixa_cofre
  add column if not exists origem_regra      text,
  add column if not exists status_inferencia text,
  add column if not exists evidencia_msg_id  text,
  add column if not exists evidencia_url     text;

alter table public.fin_transacoes_bancarias
  drop constraint if exists fin_tx_status_inferencia_chk,
  add  constraint fin_tx_status_inferencia_chk
    check (status_inferencia is null or status_inferencia in ('sugerida','confirmada','rejeitada'));

-- 2) Parcelas persistidas (hoje o app deriva em memória de fin_parcelamentos).
--    Cada parcela vira uma linha própria; o app passa a ler daqui quando existir.
create table if not exists public.fin_parcelas (
  id               bigserial primary key,
  parcelamento_id  bigint not null references public.fin_parcelamentos(id) on delete cascade,
  numero           int    not null,
  competencia      text   not null,              -- 'YYYY-MM' da parcela
  valor            numeric(12,2) not null,       -- em reais
  categoria        text,
  tipo_categoria   text default 'Despesa',
  transacao_id     bigint references public.fin_transacoes_bancarias(id) on delete set null, -- linha do extrato que a quitou
  criado_em        timestamptz default now(),
  unique (parcelamento_id, numero)
);
alter table public.fin_parcelas disable row level security;  -- mesmo padrão de fin_parcelamentos (service_role)

-- 3) Backfill das linhas já existentes
update public.fin_transacoes_bancarias set origem_regra='sync'
  where origem_regra is null and hash like 'sic%';
update public.fin_transacoes_bancarias set origem_regra='app_prolabore', status_inferencia=null
  where origem_regra is null and origem_arquivo='app_prolabore';
update public.fin_transacoes_bancarias set origem_regra='inferencia_carro', status_inferencia='confirmada'
  where origem_regra is null and categoria='Pró-labore (financ. veículo)' and observacao ilike '%confirmado no app%';
update public.fin_transacoes_bancarias set origem_regra='manual'
  where origem_regra is null;
update public.fin_livro_caixa_cofre set origem_regra=case when origem='Automático' then 'app' else 'manual' end
  where origem_regra is null;

-- 4) Índices de apoio
create index if not exists fin_tx_competencia_idx on public.fin_transacoes_bancarias(competencia);
create index if not exists fin_tx_origem_regra_idx on public.fin_transacoes_bancarias(origem_regra);

-- Conferência rápida
select origem_regra, count(*) from public.fin_transacoes_bancarias group by 1 order by 2 desc;

-- ============================================================
-- Etapa 4b — livro razão único no banco: fin_ledger(competencia, regime)
-- Replica em SQL o _ledger() do app (index.html), para que robôs (n8n,
-- fin_snapshot, digest do grupo) leiam a MESMA régua do DRE/Dashboard.
--   p_competencia: 'AAAA-MM' ou null (= todas)
--   p_regime:      'caixa' (padrão) | 'competencia'
-- Fontes: banco ∪ cofre ∪ carro inferido ∪ parcelamentos; no regime de
-- competência soma também os títulos pendentes (a receber/a pagar).
-- LACUNA ASSUMIDA: as provisões (_provisoesComoTxns — alvo − realizado,
-- médias móveis, DAS 15,5 %) ficam só no app; não entram aqui.
-- Valores em REAIS. `valor_sinal` = sinal contábil (_txSig): estorno reduz
-- despesa, devolução reduz receita.
-- ============================================================
-- normaliza "quem" (cliente/fornecedor × condomínio da linha do banco) como o app (_previstosComoTxns.norm)
create or replace function public.fin_norm_quem(p text)
returns text language sql immutable as $fn$
  select trim(regexp_replace(regexp_replace(
           translate(lower(coalesce(p,'')),'áàâãäéèêëíìîïóòôõöúùûüç','aaaaaeeeeiiiiooooouuuuc'),
           '\m(condominio|edificio|residencial|portal|cond|ed|res)\M','','g'),
         '[^a-z0-9]+',' ','g'));
$fn$;
-- mesmo critério do app: vazio casa com tudo; contém; ou alguma palavra >3 letras de um está no outro
create or replace function public.fin_mesmo_quem(a text, b text)
returns boolean language sql immutable as $fn$
  select x='' or y='' or x like '%'||y||'%' or y like '%'||x||'%'
      or exists (select 1 from regexp_split_to_table(x,' ') w where length(w)>3 and y like '%'||w||'%')
  from (select public.fin_norm_quem(a) x, public.fin_norm_quem(b) y) s;
$fn$;

create or replace function public.fin_ledger(p_competencia text default null, p_regime text default 'caixa')
returns table (
  fonte          text,     -- 'banco' | 'cofre' | 'inferencia_carro' | 'parcelamento' | 'previsto'
  ref_id         text,     -- id da linha de origem (ou id sintético)
  data           text,     -- 'AAAA-MM-DD'
  competencia    text,     -- 'AAAA-MM'
  tipo           text,     -- 'credito' | 'debito'
  tipo_categoria text,     -- 'Receita' | 'Despesa'
  categoria      text,
  valor          numeric,  -- reais, sempre positivo
  valor_sinal    numeric,  -- reais com sinal contábil
  historico      text,
  descricao      text,
  observacao     text,
  condominio     text
)
language sql
stable
security definer
set search_path = public
as $fn$
with
mes_atual as (select to_char(now() at time zone 'America/Sao_Paulo','YYYY-MM') m),
-- ── 1) banco ─────────────────────────────────────────────────────────
banco as (
  select 'banco'::text fonte, t.id::text ref_id, left(t.data::text,10) data,
         coalesce(nullif(t.competencia,''), left(t.data::text,7)) competencia,
         t.tipo, t.tipo_categoria, t.categoria, (t.valor)::numeric valor,
         t.historico, t.descricao, t.observacao, t.condominio, t.id id_num
  from public.fin_transacoes_bancarias t
),
-- ── 2) cofre (espelha _cofreComoTxns / _cofreCat / _cofreComp) ───────
cofre_raw as (
  select c.*, lower(coalesce(c.descricao,'')||' '||coalesce(c.observacao,'')) txt,
         lower(coalesce(c.descricao,'')) d
  from public.fin_livro_caixa_cofre c
  where coalesce(c.descricao,'') !~* 'saldo anterior'
),
cofre as (
  select 'cofre'::text fonte, c.id::text ref_id, left(c.data::text,10) data,
         case
           when c.txt ~ 'ref\.?\s*\d{2}/\d{4}' then (regexp_match(c.txt,'ref\.?\s*(\d{2})/(\d{4})'))[2]||'-'||(regexp_match(c.txt,'ref\.?\s*(\d{2})/(\d{4})'))[1]
           when c.txt ~ 'ref\.?\s*\d{4}-\d{2}' then (regexp_match(c.txt,'ref\.?\s*(\d{4})-(\d{2})'))[1]||'-'||(regexp_match(c.txt,'ref\.?\s*(\d{4})-(\d{2})'))[2]
           when c.txt ~ '(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+\d{4}' then
             (regexp_match(c.txt,'(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})'))[2]||'-'||
             lpad((array_position(array['janeiro','fevereiro','marco','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'],
                   translate((regexp_match(c.txt,'(janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s+de\s+(\d{4})'))[1],'ç','c')))::text,2,'0')
           else left(c.data::text,7)
         end competencia,
         case when c.tipo='Entrada' then 'credito' else 'debito' end tipo,
         case when c.tipo='Entrada' then 'Receita' else 'Despesa' end tipo_categoria,
         case
           when c.d ~ 'reembolso' and c.d ~ 'taxa|cart[óo]rio|matr[íi]cula|ficha' then 'Reembolso de taxas'
           when c.d ~ 'reembolso' then 'Reembolsos'
           when c.d ~ 'pr[óo] ?labore|sal[áa]rio|pagamento.*claudemir|claudemir' then 'Pró-labore (cofre)'
           when c.d ~ '\mart\M|taxa art' then 'Receita de ART'
           when c.d ~ 'memorial|laudo|parecer|vistoria' then 'Serviços de Engenharia'
           when c.d ~ 'recebimento|cliente|receb' then 'Receita de Projetos'
           when c.d ~ 'mercado|jos[ée]' then 'Outras entradas (cofre)'
           when c.tipo='Entrada' then 'Outras entradas (cofre)' else 'Outras saídas (cofre)'
         end categoria,
         round((c.valor)::numeric/100.0,2) valor,
         'Cofre · '||coalesce(c.descricao,'Movimentação') historico,
         c.descricao, c.observacao, null::text condominio
  from cofre_raw c
),
-- ── 3) carro do Claudemir por série (espelha _carroInferir) ──────────
carro_serie as (
  select percentile_cont(0.5) within group (order by valor) med, count(*) n
  from banco where categoria='Pró-labore (financ. veículo)' and tipo='debito' and valor>0
),
carro_meses as (select distinct competencia from banco where categoria='Pró-labore (financ. veículo)'),
carro_cand as (
  select b.*, to_char((left(b.data,7)||'-01')::date - interval '1 month','YYYY-MM') c1,
              to_char((left(b.data,7)||'-01')::date - interval '2 month','YYYY-MM') c2
  from banco b, carro_serie s
  where s.n>=2 and b.tipo='debito'
    and coalesce(b.categoria,'') in ('','Título/Boleto pago','Não classificado')
    and (coalesce(b.historico,'')||' '||coalesce(b.descricao,'')) ~* 'D[ÉE]B\.?\s*TIT'
    and abs(b.valor-s.med)/s.med <= 0.15
),
carro_inf as (
  select distinct on (comp) *
  from (
    select c.*, case when not exists (select 1 from carro_meses m where m.competencia=c.c1) then c.c1
                     when not exists (select 1 from carro_meses m where m.competencia=c.c2) then c.c2 end comp
    from carro_cand c
  ) x where comp is not null
  order by comp, data
),
banco_final as (
  select case when ci.comp is not null then 'inferencia_carro' else 'banco' end fonte,
         b.ref_id, b.data,
         coalesce(ci.comp, b.competencia) competencia,
         b.tipo, b.tipo_categoria,
         case when ci.comp is not null then 'Pró-labore (financ. veículo)' else b.categoria end categoria,
         b.valor, b.historico, b.descricao,
         case when ci.comp is not null then coalesce(b.observacao,'')||' · parcela do carro inferida pelo razão (série mensal)' else b.observacao end observacao,
         b.condominio
  from banco b left join carro_inf ci on ci.id_num=b.id_num
),
-- ── 4) parcelamentos (drone etc.; espelha _parcelamentosComoTxns) ────
parc_regras as (
  select p.id, coalesce(p.descricao,'Parcelamento') descricao, p.categoria,
         split_part(coalesce(p.socio_nome,''),' ',1) socio,
         (p.valor_parcela)::numeric parcela, (p.total_parcelas)::int n, p.competencia_inicio
  from public.fin_parcelamentos p
  where coalesce(p.valor_parcela,0)>0 and coalesce(p.total_parcelas,0)>0 and p.competencia_inicio ~ '^\d{4}-\d{2}$'
),
parc_comps as (
  select r.*, g.i, to_char((r.competencia_inicio||'-01')::date + ((g.i-1)||' month')::interval,'YYYY-MM') comp
  from parc_regras r cross join lateral generate_series(1, r.n) g(i)
),
parc_fat as (
  select pc.*, f.ref_id fat_id, f.data fat_data
  from parc_comps pc
  cross join mes_atual ma
  join lateral (
    select b.ref_id, b.data from banco_final b
    where b.categoria='Cartão de crédito'
      and coalesce(b.tipo_categoria, case when b.tipo='credito' then 'Receita' else 'Despesa' end)='Despesa'
      and b.competencia=pc.comp and b.valor>=pc.parcela
      and (case when (coalesce(b.descricao,'')||' '||coalesce(b.observacao,'')||' '||coalesce(b.historico,'')) ~* 'rog[ée]rio|937\.788|rosemeire|rosemary' then 'Rogério' else 'Claudemir' end)=pc.socio
    order by b.data limit 1
  ) f on true
  where pc.comp <= ma.m
),
parc as (
  select 'parcelamento'::text fonte, 'parc-'||id||'-'||comp||'-e' ref_id, fat_data data, comp competencia,
         'credito'::text tipo, 'Despesa'::text tipo_categoria, 'Cartão de crédito'::text categoria, parcela valor,
         'Estorno · '||descricao||' parcela '||i||'/'||n||' (despesa da empresa, não onera o sócio)' historico,
         ''::text descricao, 'Regra de parcelamento #'||id||' aplicada à fatura '||fat_id observacao, null::text condominio
  from parc_fat
  union all
  select 'parcelamento', 'parc-'||id||'-'||comp||'-d', fat_data, comp,
         'debito', 'Despesa', coalesce(categoria,'Imobilizado / Equipamentos'), parcela,
         descricao||' parcela '||i||'/'||n||' · cartão '||socio, '', 'Regra de parcelamento #'||id||' (fatura '||fat_id||')', null
  from parc_fat
),
-- ── 5) previstos (só regime de competência; espelha _previstosComoTxns) ──
prev_src as (
  select 'r'::text k, r.id, r.cliente quem, r.categoria, r.descricao, (r.valor)::numeric valor, r.data_vencimento::date venc, r.numero_nfse::text nf,
         'credito'::text tipo, 'Receita'::text nat, 'r'::text idcol
  from public.fin_contas_receber r where r.status='Pendente' and coalesce(r.estornado,false)=false
  union all
  select 'p', p.id, p.fornecedor, p.categoria, p.descricao, (p.valor)::numeric, p.data_vencimento::date, null,
         'debito', 'Despesa', 'p'
  from public.fin_contas_pagar p where p.status='Pendente' and coalesce(p.estornado,false)=false
),
prev as (
  select 'previsto'::text fonte, 'prev-'||s.k||s.id ref_id, s.venc::text data,
         case when (coalesce(s.categoria,'')||' '||coalesce(s.descricao,'')) ~* 'assessor|mensalidade|mensais|pr[óo].?labore|imposto|tributo|das\M|cart[ãa]o|contabil|reembolso'
              then to_char(date_trunc('month',s.venc) - interval '1 month','YYYY-MM') else to_char(s.venc,'YYYY-MM') end competencia,
         s.tipo, s.nat tipo_categoria, coalesce(s.categoria, case when s.nat='Receita' then 'Assessoria' else 'Outros' end) categoria,
         round(s.valor/100.0,2) valor,
         (case when s.nat='Receita' then 'A receber · ' else 'A pagar · ' end)||coalesce(s.quem,'—')||coalesce(' · NF '||s.nf,'')||' · venc '||to_char(s.venc,'DD/MM/YYYY') historico,
         coalesce(s.descricao,'') descricao, 'Previsto (regime de competência): ainda não pago'::text observacao,
         case when s.nat='Receita' then s.quem end condominio
  from prev_src s
  where s.venc is not null
    and not exists (   -- anti-dupla-contagem: mesmo valor, mesmo tipo, sem vínculo, pago de 15 dias antes a 90 depois
      select 1 from public.fin_transacoes_bancarias t
      where t.tipo=s.tipo
        and ((s.idcol='r' and t.conta_receber_id is null) or (s.idcol='p' and t.conta_pagar_id is null))
        and round(t.valor*100)=round(s.valor)
        and t.data::date between s.venc - 15 and s.venc + 90
        and public.fin_mesmo_quem(t.condominio, s.quem)
    )
),
-- ── união ────────────────────────────────────────────────────────────
tudo as (
  select fonte, ref_id, data, competencia, tipo, tipo_categoria, categoria, valor, historico, descricao, observacao, condominio from banco_final
  union all select fonte, ref_id, data, competencia, tipo, tipo_categoria, categoria, valor, historico, descricao, observacao, condominio from cofre
  union all select fonte, ref_id, data, competencia, tipo, tipo_categoria, categoria, valor, historico, descricao, observacao, condominio from parc
  union all select fonte, ref_id, data, competencia, tipo, tipo_categoria, categoria, valor, historico, descricao, observacao, condominio from prev where p_regime='competencia'
),
nat as (
  select *, coalesce(tipo_categoria, case when tipo='credito' then 'Receita' else 'Despesa' end) natureza from tudo
)
select fonte, ref_id, data, competencia, tipo, natureza tipo_categoria, categoria, valor,
       (case when tipo = (case when natureza='Receita' then 'credito' else 'debito' end) then 1 else -1 end) * valor valor_sinal,
       historico, descricao, observacao, condominio
from nat
where p_competencia is null or competencia = p_competencia
order by data, ref_id;
$fn$;

grant execute on function public.fin_ledger(text, text) to service_role;

-- Totais da competência na mesma régua do app (receita, despesa, resultado)
create or replace function public.fin_ledger_totais(p_competencia text, p_regime text default 'caixa')
returns jsonb language sql stable security definer set search_path = public as $fn$
  select jsonb_build_object(
    'competencia', p_competencia, 'regime', p_regime,
    'receitas_total', round(coalesce(sum(valor_sinal) filter (where tipo_categoria='Receita'),0),2),
    'despesas_total', round(coalesce(sum(valor_sinal) filter (where tipo_categoria='Despesa'),0),2),
    'resultado',      round(coalesce(sum(valor_sinal) filter (where tipo_categoria='Receita'),0)
                          - coalesce(sum(valor_sinal) filter (where tipo_categoria='Despesa'),0),2),
    'n', count(*),
    'por_categoria', coalesce((select jsonb_agg(c) from (
        select jsonb_build_object('natureza',tipo_categoria,'categoria',categoria,'total',round(sum(valor_sinal),2),'n',count(*)) c
        from public.fin_ledger(p_competencia,p_regime) group by tipo_categoria,categoria order by sum(valor_sinal) desc) t),'[]'::jsonb)
  ) from public.fin_ledger(p_competencia,p_regime);
$fn$;
grant execute on function public.fin_ledger_totais(text, text) to service_role;

-- Conferência: 3 meses × 2 regimes (comparar com o DRE do app)
select m, r, (public.fin_ledger_totais(m,r))->>'receitas_total' rec, (public.fin_ledger_totais(m,r))->>'despesas_total' desp
from (values ('2026-06'),('2026-07'),('2026-08')) v(m), (values ('caixa'),('competencia')) w(r) order by 1,2;

-- ============================================================
-- fin_snapshot: bloco dre passa a ler o razão único (cópia de _setup_robo_financeiro.sql)
-- ============================================================
create or replace function public.fin_snapshot(p_competencia text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  comp text := coalesce(p_competencia, to_char(now() at time zone 'America/Sao_Paulo','YYYY-MM'));
  hoje date := (now() at time zone 'America/Sao_Paulo')::date;
  result jsonb;
begin
  select jsonb_build_object(
    'gerado_em', to_char(now() at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
    'competencia', comp,

    'a_receber', (
      select jsonb_build_object(
        'pendente_total', round(coalesce(sum(valor),0)/100.0,2),
        'vencido_total',  round(coalesce(sum(valor) filter (where data_vencimento < hoje),0)/100.0,2),
        'qtd', count(*),
        'proximos', coalesce((
          select jsonb_agg(jsonb_build_object(
            'cliente',cliente,'categoria',categoria,
            'valor',round(valor/100.0,2),'vencimento',to_char(data_vencimento,'DD/MM/YYYY'),
            'vencido',(data_vencimento < hoje)))
          from (select * from public.fin_contas_receber
                where status='Pendente' and coalesce(estornado,false)=false
                order by data_vencimento limit 15) s), '[]'::jsonb)
      ) from public.fin_contas_receber
      where status='Pendente' and coalesce(estornado,false)=false
    ),

    'a_pagar', (
      select jsonb_build_object(
        'pendente_total', round(coalesce(sum(valor),0)/100.0,2),
        'vencido_total',  round(coalesce(sum(valor) filter (where data_vencimento < hoje),0)/100.0,2),
        'qtd', count(*),
        'proximos', coalesce((
          select jsonb_agg(jsonb_build_object(
            'fornecedor',fornecedor,'categoria',categoria,
            'valor',round(valor/100.0,2),'vencimento',to_char(data_vencimento,'DD/MM/YYYY'),
            'vencido',(data_vencimento < hoje)))
          from (select * from public.fin_contas_pagar
                where status='Pendente' and coalesce(estornado,false)=false
                order by data_vencimento limit 15) s), '[]'::jsonb)
      ) from public.fin_contas_pagar
      where status='Pendente' and coalesce(estornado,false)=false
    ),

    'recebido_competencia', (
      select round(coalesce(sum(valor),0)/100.0,2) from public.fin_contas_receber
      where status='Recebido' and coalesce(estornado,false)=false
        and to_char(data_recebimento::date,'YYYY-MM')=comp),
    'pago_competencia', (
      select round(coalesce(sum(valor),0)/100.0,2) from public.fin_contas_pagar
      where status='Pago' and coalesce(estornado,false)=false
        and to_char(data_pagamento::date,'YYYY-MM')=comp),

    -- DRE da competência pelo livro razão único (fin_ledger, _migra_ledger.sql — etapa 4b):
    -- banco ∪ cofre ∪ carro inferido ∪ parcelamentos, mesma régua do DRE do app (regime caixa)
    'dre', public.fin_ledger_totais(comp, 'caixa'),
    -- mesma competência no regime de competência (inclui títulos pendentes; sem provisões)
    'dre_competencia', public.fin_ledger_totais(comp, 'competencia'),

    'conciliacao', (
      select jsonb_build_object(
        'conciliados', count(*) filter (where status='conciliado' or conta_receber_id is not null or conta_pagar_id is not null),
        'pendentes', count(*) filter (where status<>'conciliado' and conta_receber_id is null and conta_pagar_id is null)
      ) from public.fin_transacoes_bancarias where competencia=comp
    ),

    'ultimas_transacoes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'data',to_char(data::date,'DD/MM/YYYY'),'historico',historico,
        'categoria',categoria,'tipo',tipo,'valor',round(valor,2)))
      from (select * from public.fin_transacoes_bancarias
            order by data desc, id desc limit 20) u), '[]'::jsonb)
  ) into result;

  return result;
end $$;
