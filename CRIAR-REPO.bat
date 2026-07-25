@echo off
cd /d "%~dp0"
echo Criando repositorio diagnostika-engenharia/financeiro (publico)...
gh repo create diagnostika-engenharia/financeiro --public --source=. --remote=origin --push
echo.
echo Pronto. Pode fechar esta janela e voltar ao Claude.
pause
