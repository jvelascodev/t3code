# Atomic

Install [Atomic](https://github.com/bastani-inc/atomic) on the machine running your T3 Code server:

```sh
npm install -g @bastani/atomic
atomic
```

Run `/login` in Atomic to connect your model provider. In T3 Code, open **Settings → Providers → Add provider** and choose **Atomic**. Set a binary path if `atomic` is not on the server's PATH.

Choose **Atomic default** to use the CLI's configured model, or refresh the model list in provider settings to discover available models. For discovered models that support reasoning, choose an effort in the composer. Choose **Atomic setting** to return to Atomic's own reasoning level. Custom model IDs use `provider/model-id`. For separate credential directories, set `ATOMIC_CODING_AGENT_DIR` in the provider instance's environment variables and authenticate Atomic with the same setting.

Atomic threads support streamed text and reasoning, tool activity, images, session resume, model switching, interruption, and basic extension questions. Web, desktop, and mobile clients connect to the same server-side process, including over remote connections.

Use **Full access** for Atomic threads. Atomic has no built-in sandbox or shell approval gate, so T3 rejects other permission modes. Restricted plan mode, conversation rollback, and background generation of titles or Git text are not supported. Use another provider for background text generation. Atomic's interactive terminal UI and custom extension widgets are not embedded in T3.
