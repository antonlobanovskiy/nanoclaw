# LiteLLM Proxy Configuration for NanoClaw

NanoClaw is designed to work natively with Anthropic's Claude models. To use GitHub Copilot for free behind the scenes, we use LiteLLM as a proxy to intercept Claude model requests and translate them into Copilot requests.

## Programmatically Checking Available Models

GitHub Copilot updates its model list frequently. You can programmatically fetch the exact list of native models currently supported by your local Copilot CLI installation by parsing its help menu:

copilot --help | grep -oP '(?<=--model <model>).*?(?=\))' | grep -oP '"\K[^"]+'

This command outputs a clean list of exactly what models Copilot can use, straight from the source. When configuring LiteLLM, you prepend `github_copilot/` to these exact names.

## Current Model Mappings

Since NanoClaw specifically asks for Anthropic models, we map those requests directly to GitHub Copilot's equivalent Claude models.

Here is the clean structure of your `~/dev/litellm/litellm_config.yaml`:

```yaml
model_list:
  - model_name: "claude-sonnet-4-6" 
    litellm_params:
      model: "github_copilot/claude-sonnet-4.6" 

  - model_name: "claude-opus-4-6" 
    litellm_params:
      model: "github_copilot/claude-opus-4.6" 

  - model_name: "claude-3-5-haiku-20241022"
    litellm_params:
      model: "github_copilot/claude-haiku-4.5"

litellm_settings:
  master_key: "sk-nanoclaw-local"
  drop_params: true
```

## How to Update When New Models Release

If NanoClaw starts requesting a newer model, or you see a new one available in Copilot:

1. Use the script above to verify the exact model name supported by Copilot.
2. Open `~/dev/litellm/litellm_config.yaml`.
3. Update the `litellm_params` to map to the new `github_copilot/<new-model-name>`.
4. Restart the LiteLLM proxy:

pkill -f litellm
cd ~/dev/litellm
litellm --config litellm_config.yaml --port 4000 > litellm.log 2>&1 &