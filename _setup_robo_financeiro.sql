-- ============================================================
-- Camada de dados do ROBÔ FINANCEIRO (WhatsApp → n8n → IA)
-- Rode UMA vez no Supabase: SQL Editor > New query > cole tudo > Run
-- Idempotente. Cria funções read-only que o agente de IA consulta
-- para responder QUALQUER pergunta sobre o financeiro.
--
-- Pré-requisito: as tabelas do financeiro já existem
-- (_setup_tabelas_financeiro.sql). valor em fin_contas_* está em
-- CENTAVOS; em fin_transacoes_bancarias está em REAIS. As funções
-- normalizam tudo para REAIS no JSON de saída.
--
-- IMPORTANTE: a coluna `data` em fin_transacoes_bancarias é TEXT
-- (formato AAAA-MM-DD), por isso usamos to_char(data::date,...) e
-- data_vencimento/recebimento/pagamento::date. DEPLOYADO 16/06/2026.
-- ============================================================

-- ------------------------------------------------------------
-- 1) fin_snapshot(competencia) → visão consolidada (JSON)
--    competencia no formato 'AAAA-MM'. Se null, usa o mês atual.
-- ------------------------------------------------------------
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

    -- DRE da competência a partir do extrato conciliado/importado
    'dre', (
      select jsonb_build_object(
        'receitas_total', round(coalesce(sum(valor) filter (where tipo='credito'),0),2),
        'despesas_total', round(coalesce(sum(valor) filter (where tipo='debito'),0),2),
        'resultado', round(coalesce(sum(case when tipo='credito' then valor else -valor end),0),2),
        'por_categoria', coalesce((
          select jsonb_agg(c) from (
            select jsonb_build_object('natureza',tipo_categoria,'categoria',categoria,
              'total',round(sum(valor),2),'n',count(*)) c
            from public.fin_transacoes_bancarias
            where competencia=comp
            group by tipo_categoria,categoria
            order by sum(valor) desc) t), '[]'::jsonb)
      ) from public.fin_transacoes_bancarias where competencia=comp
    ),

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

-- ------------------------------------------------------------
-- 2) fin_busca_transacoes(termo, limite) → procura no extrato
--    Ex.: "quanto paguei de energia?", "recebi do Matisse?"
-- ------------------------------------------------------------
create or replace function public.fin_busca_transacoes(p_termo text, p_limite int default 30)
returns jsonb
language sql
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'data',to_char(data::date,'DD/MM/YYYY'),'historico',historico,
    'categoria',categoria,'tipo',tipo,'valor',round(valor,2),
    'competencia',competencia)), '[]'::jsonb)
  from (
    select * from public.fin_transacoes_bancarias
    where p_termo is null or p_termo=''
       or historico ilike '%'||p_termo||'%'
       or categoria ilike '%'||p_termo||'%'
    order by data desc, id desc
    limit greatest(1, least(p_limite, 200))
  ) t;
$$;

-- ------------------------------------------------------------
-- Permissões: o robô (n8n) usa a service_role, que ignora RLS.
-- Liberamos também para usuários autenticados (uso no painel).
-- NÃO liberamos para anon.
-- ------------------------------------------------------------
grant execute on function public.fin_snapshot(text)            to authenticated, service_role;
grant execute on function public.fin_busca_transacoes(text,int) to authenticated, service_role;
revoke execute on function public.fin_snapshot(text)            from anon, public;
revoke execute on function public.fin_busca_transacoes(text,int) from anon, public;

select 'OK — funções do robô financeiro criadas (fin_snapshot, fin_busca_transacoes)' as resultado;
