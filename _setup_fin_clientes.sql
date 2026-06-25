-- ============================================================
-- Tabela fin_clientes — Cadastro de condomínios/clientes
-- Rode no Supabase: Dashboard > SQL Editor > New query > cole tudo > Run
-- Idempotente: pode rodar de novo sem quebrar nada.
-- ============================================================

create extension if not exists pgcrypto;

-- 1) Tabela
create table if not exists public.fin_clientes (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  cnpj text not null,
  inscricao_municipal text,
  razao_social text,
  endereco text,
  cidade text,
  uf text default 'SP',
  cep text,
  cod_municipio text,
  email_financeiro text,
  telefone text,
  valor_mensal integer not null default 0,
  iss_retido boolean not null default false,
  aliquota_iss numeric(5,2),
  descricao_padrao text,
  canal_envio text,
  parcelas_total integer,
  parcelas_emitidas integer,
  ativo boolean not null default true,
  faturamento_ativo boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Índice único no CNPJ
create unique index if not exists fin_clientes_cnpj_uq on public.fin_clientes(cnpj);

-- Trigger para updated_at automático
create or replace function public.fin_clientes_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_fin_clientes_updated on public.fin_clientes;
create trigger trg_fin_clientes_updated
  before update on public.fin_clientes
  for each row execute function public.fin_clientes_updated_at();

-- 2) Grants + RLS
grant select, insert, update, delete on public.fin_clientes to authenticated;
grant select, insert, update, delete on public.fin_clientes to anon;
alter table public.fin_clientes enable row level security;

drop policy if exists "fin_clientes_select" on public.fin_clientes;
create policy "fin_clientes_select" on public.fin_clientes for select to authenticated using (true);

drop policy if exists "fin_clientes_insert" on public.fin_clientes;
create policy "fin_clientes_insert" on public.fin_clientes for insert to authenticated with check (true);

drop policy if exists "fin_clientes_update" on public.fin_clientes;
create policy "fin_clientes_update" on public.fin_clientes for update to authenticated using (true) with check (true);

drop policy if exists "fin_clientes_delete" on public.fin_clientes;
create policy "fin_clientes_delete" on public.fin_clientes for delete to authenticated using (true);

-- 3) Carga inicial — 6 condomínios (upsert pelo CNPJ)
insert into public.fin_clientes (nome, cnpj, razao_social, inscricao_municipal, cidade, uf, cep, cod_municipio, email_financeiro, telefone, valor_mensal, iss_retido, aliquota_iss, descricao_padrao, canal_envio, parcelas_total, parcelas_emitidas, faturamento_ativo)
values
  ('Residencial Jardins do Malta',
   '39520821000194',
   'CONDOMÍNIO RESIDENCIAL JARDINS DO MALTA',
   null,
   'Hortolândia', 'SP', '13185096', '3519055',
   'financeiro01@apto.adm.br', null,
   200000, false, null,
   E'Prestação de serviços técnicos mensais de assessoria em engenharia condominial, conforme contrato. Incluindo visitas técnicas, emissão de documentos, suporte remoto, análise de obras e reformas.\nPagamento realizado via PIX Chave CNPJ: 54.027.948/0001-60.\nVencimento {{vencimento}}',
   'megazap', null, null, true),

  ('Edifício Village Matisse',
   '54127097000127',
   'CONDOMINIO EDIFICIO VILLAGE MATISSE',
   '001017195',
   'Campinas', 'SP', '13026002', '3509502',
   'merlizc@hotmail.com', '19991710702',
   115000, true, 2.17,
   E'Serviços de engenharia - Elaboração de Projeto de Infraestrutura para Ar Condicionado - Contrato DK-2025-VM - Parcela {{parcela}}/12.\nValor: R$ {{valor}}\nVencimento: {{vencimento}}\nForma de Pagamento: PIX\nDados Bancários:\nBanco Sicoob - Diagnóstika Engenharia LTDA - CNPJ 54.027.948/0001-60\nChave PIX: 54.027.948/0001-60',
   null, 12, 8, true),

  ('Residencial Santa Clara',
   '39836306000118',
   'RESIDENCIAL SANTA CLARA',
   null,
   'Paulínia', 'SP', '13145756', '3536505',
   'financeiro@rbodemir.com.br', null,
   162100, false, null,
   E'Prestação de serviços técnicos de engenharia, compreendendo assessoria mensal à administração condominial, emissão de pareceres técnicos, vistorias em campo e apoio à gestão de manutenção predial\nSERVIÇOS DE ENGENHARIA\nPIX CNPJ: 54.027.948/0001-60 DIAGNOSTIKA ENGENHARIA\nVencimento {{vencimento}}',
   null, null, null, true),

  ('Portal Primavera',
   '26481953000102',
   'PORTAL PRIMAVERA',
   null,
   'Hortolândia', 'SP', '13183255', '3519055',
   'contasapagar@destracondominios.com', null,
   175000, false, null,
   E'Prestação de serviços técnicos de engenharia, compreendendo assessoria mensal à administração condominial, emissão de pareceres técnicos, vistorias em campo, apoio à gestão de manutenção predial e acompanhamento técnico conforme contrato firmado.\nValor faturado nesta competência conforme condição comercial concedida por liberalidade, em caráter provisório, sem prejuízo das condições contratuais vigentes\nR$ {{valor}} Contrato mensal\nForma de pagamento: PIX para Diagnóstika Engenharia LTDA CNPJ 54.027.948/0001-60\nBanco: Sicoob\nChave PIX: 54.027.948/0001-60\nVencimento: {{vencimento}}',
   null, null, null, true),

  ('Condomínio Residencial Monte Carlo',
   '63079240000143',
   'CONDOMÍNIO RESIDENCIAL MONTE CARLO',
   null,
   'Paulínia', 'SP', '13140135', '3536505',
   'montecarlopaulinia@gmail.com', null,
   295000, false, null,
   E'Prestação de serviços técnicos de engenharia, compreendendo assessoria mensal à administração condominial, emissão de pareceres técnicos, vistorias em campo e apoio à gestão de manutenção predial\nSERVIÇOS DE ENGENHARIA\nPIX CNPJ: 54.027.948/0001-60 DIAGNOSTIKA ENGENHARIA\nVencimento {{vencimento}}',
   null, null, null, true),

  ('Morada Morumbi',
   '42407400000166',
   'CONDOMÍNIO MORADA MORUMBI',
   null,
   'Paulínia', 'SP', '13140770', '3536505',
   'sindico.moradamorumbi@gmail.com', null,
   243150, false, null,
   E'Prestação de serviços técnicos de engenharia, compreendendo assessoria mensal à administração condominial, emissão de pareceres técnicos, vistorias em campo e apoio à gestão de manutenção predial\nSERVIÇOS DE ENGENHARIA\nPIX CNPJ: 54.027.948/0001-60 DIAGNOSTIKA ENGENHARIA\nVencimento {{vencimento}}',
   null, null, null, true)

on conflict (cnpj) do update set
  nome = excluded.nome,
  razao_social = excluded.razao_social,
  endereco = coalesce(excluded.endereco, public.fin_clientes.endereco),
  cep = coalesce(excluded.cep, public.fin_clientes.cep),
  email_financeiro = coalesce(excluded.email_financeiro, public.fin_clientes.email_financeiro),
  descricao_padrao = coalesce(excluded.descricao_padrao, public.fin_clientes.descricao_padrao),
  valor_mensal = excluded.valor_mensal,
  faturamento_ativo = excluded.faturamento_ativo,
  updated_at = now();
