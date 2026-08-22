# Hydra Discord Status Bot — Railway

Este pacote contém somente o bot Discord de status do Hydra Notifier. A estrutura é plana e não inclui o site Hydra, TypeScript, `dist` ou subpastas de código.

## Arquivos

```text
index.js
package.json
railway.json
.env.example
README.md
```

## Variáveis na Railway

No painel da Railway, abra **Variables** e cadastre:

| Variável | Valor |
|---|---|
| `DISCORD_BOT_TOKEN` | Novo token privado do bot Discord |
| `DISCORD_GUILD_ID` | `1526298581873459220` |
| `DISCORD_BUYER_ROLE_ID` | `1536881467026571285` |
| `DISCORD_STATUS_CHANNEL_ID` | `1528902136060973318` |
| `HYDRA_API_URL` | URL pública do site Hydra depois da publicação |
| `HYDRA_BOT_API_KEY` | Chave privada compartilhada com o site Hydra |

Nunca coloque tokens no código, no README ou no GitHub. Se o site ainda não foi publicado, deixe `HYDRA_API_URL` e `HYDRA_BOT_API_KEY` pendentes; o bot poderá conectar ao Discord, mas não conseguirá consultar Keys e Slots.

## Deploy na Railway

Envie estes arquivos na raiz do repositório ou do pacote:

```text
index.js
package.json
railway.json
.env.example
README.md
```

A Railway executará automaticamente:

```bash
npm start
```

O `package.json` já instala `discord.js` e `dotenv`. Não execute `npm run build` e não use `node dist/index.js`.

## Execução local

```bash
npm install
cp .env.example .env
# preencha o .env com valores reais
npm start
```

## Funcionamento

Depois de conectar, o bot consulta o endpoint privado `/api/bot/snapshot` imediatamente e repete a consulta a cada 15 segundos. Em cada ciclo, ele identifica compradores com Key ativa e não expirada, adiciona o cargo Buyer após a compra, remove o cargo quando a Key expira, é pausada ou é removida e cria ou atualiza uma única embed no canal de status.

A concessão do cargo ocorre no primeiro ciclo após a compra, com no máximo 15 segundos de atraso. O bot também atualiza os minutos restantes dos compradores na embed.

## Permissões Discord

O bot precisa de **Ver canal**, **Enviar mensagens**, **Incorporar links**, **Ler histórico de mensagens** e **Gerenciar cargos**. O cargo do bot precisa estar acima do cargo Buyer `1536881467026571285` na hierarquia do servidor. No canal `1528902136060973318`, permita explicitamente **Enviar mensagens** para o cargo do bot.

## API privada do Hydra

O bot faz uma requisição `GET` para:

```text
${HYDRA_API_URL}/api/bot/snapshot
```

Enviando:

```text
Authorization: Bearer ${HYDRA_BOT_API_KEY}
```

O site precisa estar publicado para que a URL seja acessível pela Railway. A chave configurada na Railway deve ser exatamente a mesma chave privada configurada no site Hydra.
