# claude-mods

Mods para o Claude Code. Hoje: **model-router**.

## model-router

Analisa cada prompt no momento do envio e diz se o modelo e o esforço selecionados são os certos para ele. Se outro modelo rende mais, interrompe o envio, reescreve o prompt com um resumo da conversa, copia o resultado para a área de transferência e pede que você abra um novo chat com o modelo indicado. Também registra, para cada prompt, quantos tokens e quanto tempo o mod estimou e quanto o prompt realmente gastou, para você ver se as estimativas se sustentam.

### Instalação

No terminal:

```
/plugin install model-router --marketplace brunoleocam/claude-mods
```

No app desktop, onde `/plugin` não roda: clique em **+** ao lado da caixa de prompt, depois em **Plugins**, **Add marketplace** com `brunoleocam/claude-mods` e **Add plugin**.

### Como funciona

1. Você envia um prompt de 40 caracteres ou mais. O mod o segura e pede uma análise ao modelo atual, sobre a conversa (com o cache compartilhado). Sem conversa ainda, usa o Opus em medium.
2. A análise segue a tabela do guia de escolha de modelos da Anthropic: Opus 5.5 em medium como padrão, Sonnet para código bem delimitado, Haiku para classificação e extração, Fable para refatorações, migrações e arquitetura.
3. Se o modelo atual serve, o prompt segue. Se outro rende mais e a confiança é de pelo menos 75%, o mod interrompe, copia o prompt refinado e mostra três botões acima do prompt: **Enviar aqui mesmo**, **Copiar de novo** e **Descartar**.
4. Depois de cada resposta, uma linha colorida mostra o gasto real ao lado da estimativa, por exemplo `⏱ 54s est 20s–70s ✓ · ↗ out 3.1k est 2k–6k ✓`.

A faixa acima do prompt também mostra o contexto usado e o tempo restante do cache (`Cache · XXm`).

### Comandos

| Comando | O que faz |
| --- | --- |
| `/router log` | Precisão das estimativas (dentro, acima e abaixo da faixa), custo médio da análise e quantas sugestões foram seguidas |
| `/router send` | Envia o prompt retido neste chat mesmo assim |
| `/router on` / `/router off` | Liga e desliga a análise |
| `/router export` | Grava o log em `~/.claude/model-router-log.json` |
| `/router reset` | Apaga o log |

### O que você precisa saber

- **Cada prompt analisado tem um custo.** A análise é uma chamada ao modelo, que acrescenta alguns segundos ao envio e consome um pouco da sua janela de uso. `/router log` mostra a média real.
- **O log guarda texto da sua conversa.** Quando o mod interrompe um prompt, o log inclui o resumo da conversa e o prompt refinado. Fica no armazenamento do mod e em `~/.claude/model-router-log.json`; não sai do seu computador, mas apague com `/router reset` antes de compartilhar o arquivo.
- **O prazo do cache é uma suposição.** O Claude Code não informa quanto o cache dura; o mod assume 60 minutos desde a última resposta. Se o seu for de 5 minutos, mude `CACHE_TTL_MS` em `plugins/model-router/hooks/register.tsx`.
- **O mod não abre um novo chat.** Ele copia o prompt refinado; abrir o chat e escolher o modelo é com você.
- **As sugestões são de um modelo, não uma regra exata.** Use o log para decidir se confia nelas.
- **Para trocar a confiança mínima** (75%), edite `MIN_CONFIDENCE` em `plugins/model-router/hooks/analyze.ts`.

### Licença

MIT.
