# OpenRouter opcional

No Runtime do agente, selecione OpenRouter, escolha explicitamente um modelo do catálogo com ferramentas e informe uma chave ou reutilize uma credencial do workspace. Testar conexão salva a chave no cofre e consulta `/key` e `/models`; não gera completions. Salvar runtime aplica o vínculo. Apenas selecionar o cartão não modifica o runtime ativo. Campo vazio na edição mantém a credencial.

Configuração persistida: `authCredentialId`, `model`, `timeoutMs` (75.000 ms por padrão). Não configure URL, headers nem payload. O endereço é fixo em `https://openrouter.ai/api/v1`. Importações precisam de uma referência válida a credencial do workspace destino; a chave não é exportada.

O adapter usa streaming, acumula chamadas de ferramenta completas, preserva IDs/metadados e devolve resultados executados pela plataforma. Chat, canais e tarefas usam o executor de permissões; ações que exigem aprovação não são aprovadas pelo adapter. Falhas, cancelamento e timeout não trocam modelo/provedor. O contexto inclui orçamento de ferramentas e o adapter recusa contexto incompatível com o modelo selecionado.

Testes simulados cobrem catálogo, autenticação sem inferência, escopo de credenciais, streaming fragmentado, continuidade de ferramentas, erros de provedor, prazos, eventos de tarefas e formulário. O teste Playwright `e2e/ui/openrouter.spec.ts` usa catálogo oficial público, armazenamento real de credencial de teste e autenticação simulada. Para usar o Edge instalado: `PLAYWRIGHT_BROWSER_CHANNEL=msedge`.

Limitação preexistente observada na Agentis principal: o typecheck geral da API acusa definições ausentes como `agentMissions`, `durableSuspensions`, `appDefinitions` e métodos WhatsApp Cloud. A integração não reescreve esses subsistemas; seus testes específicos e os bundles são verificados separadamente. O utilitário de proteção de instruções já importado pelo código, mas ausente no checkout, foi recuperado para permitir a compilação do bundle.

Referências: [ferramentas](https://openrouter.ai/docs/guides/features/tool-calling), [catálogo](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties), [autenticação](https://openrouter.ai/docs/api/api-reference/api-keys/get-current-api-key).
