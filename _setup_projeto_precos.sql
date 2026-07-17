-- ============================================================
-- PRECIFICAÇÃO DE PROJETO: tabela de preços + metragem
-- Aplicado 17/07/2026 (via pooler). Aditivo e idempotente.
--
-- POR QUE (a lição de 17/07): o robô perguntou "codigo = valor" e o Claudemir
-- respondeu com o MODELO DE PREÇO, não com valores:
--   "Erica sao por metros quadrados da construcao"
--   "Casa terrea dentro do condominio 4.500 / Casa sobrado 5.500 / fora do
--    condominio valores menor que este acima"
--   "Casa com Doni/Erica cobramos valor agilidade a parte, demais projetos
--    (Luis, Rodrigo, Lucas, Alexandre) valor embutido no valor"
-- O feeder marcou tudo como irrelevante (0 updates) — e fez certo em não chutar.
-- A pergunta e o modelo é que estavam errados: eles não têm "um valor por
-- projeto", têm uma REGRA (tipo/m²) + a METRAGEM de cada projeto.
--
--   preço = f(tipo, metragem)   -> regra da empresa (pergunta 1x)
--   metragem                    -> varia por projeto (pergunta por projeto)
--   valor                       -> CALCULADO, não digitado
--
-- A metragem já circula nas conversas: Marcus disse "ART para 270,95m2" (N-09)
-- e o Claudemir falou "area total ocupada no terreno 237,23" com a Erica.
-- ============================================================

create extension if not exists pgcrypto;

-- ── Tabela de preços (regra da empresa) ─────────────────────────────
create table if not exists public.projeto_precos (
  id uuid primary key default gen_random_uuid(),
  descricao text not null unique,          -- "Casa térrea dentro do condomínio"
  modo text not null default 'fixo' check (modo in ('fixo','por_m2')),
  valor_centavos bigint,                   -- fixo: o preço; por_m2: o preço do m² (null = falta informar)
  agilidade text not null default 'embutida' check (agilidade in ('embutida','a_parte')),
  ativo boolean not null default true,
  obs text,
  criado_em timestamptz not null default now()
);

grant select, insert, update, delete on public.projeto_precos to authenticated;
grant all on public.projeto_precos to service_role;
alter table public.projeto_precos enable row level security;
drop policy if exists team_full_projeto_precos on public.projeto_precos;
create policy team_full_projeto_precos on public.projeto_precos
  for all to authenticated using (is_diagnostika_team()) with check (is_diagnostika_team());

-- ── No projeto: a metragem (variável) + qual regra de preço se aplica ──
alter table public.fin_projetos add column if not exists metragem_m2 numeric(10,2);
alter table public.fin_projetos add column if not exists preco_id uuid references public.projeto_precos(id) on delete set null;

comment on column public.fin_projetos.metragem_m2 is
  'Metragem da construção (m²). É a variável que define o preço quando a regra é por_m2.';
comment on column public.fin_projetos.preco_id is
  'Regra de preço aplicada (projeto_precos). Com ela + metragem, o valor se calcula.';

-- ── Seed: exatamente o que o Claudemir disse no grupo em 17/07 ──────
insert into public.projeto_precos (descricao, modo, valor_centavos, agilidade, obs) values
  ('Casa térrea dentro do condomínio', 'fixo', 450000, 'embutida',
   'Claudemir no grupo 17/07: "Casa terrea dentro do condominio 4.500". Agilidade embutida (Luis, Rodrigo, Lucas, Alexandre).'),
  ('Casa sobrado dentro do condomínio', 'fixo', 550000, 'embutida',
   'Claudemir no grupo 17/07: "Casa sobrado dento do condominio 5.500". Agilidade embutida.'),
  ('Casa fora do condomínio', 'fixo', null, 'embutida',
   'Claudemir 17/07: "Casa fora do condominio valores menor que este acima" — FALTA o valor.'),
  ('Por m² da construção (Erica/Doni)', 'por_m2', null, 'a_parte',
   'Claudemir 17/07: "Erica sao por metros quadrados da construcao" e "Casa com Doni/Erica cobramos valor agilidade a parte" — FALTA o preço do m².')
on conflict (descricao) do update set
  modo = excluded.modo, agilidade = excluded.agilidade, obs = excluded.obs;

-- Conferência:
-- select descricao, modo, valor_centavos/100.0 as valor, agilidade from projeto_precos order by descricao;
-- select c.nome, p.codigo, p.metragem_m2, pr.descricao, pr.modo,
--        case when pr.modo='fixo' then pr.valor_centavos
--             when pr.modo='por_m2' then round(pr.valor_centavos * p.metragem_m2) end as valor_calculado_centavos
--   from fin_projetos p join fin_projeto_clientes c on c.id=p.cliente_id
--   left join projeto_precos pr on pr.id=p.preco_id order by c.nome;
