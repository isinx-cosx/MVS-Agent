

<!DOCTYPE html>

<html lang="en-US">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="X-UA-Compatible" content="IE=Edge">

  <link rel="stylesheet" href="/assets/css/just-the-docs-default.css">

  <link rel="stylesheet" href="/assets/css/just-the-docs-head-nav.css" id="jtd-head-nav-stylesheet">

  <style id="jtd-nav-activation">
  

.site-nav > ul.nav-list:first-child > li > a,
.site-nav > ul.nav-list:first-child > li > ul > li:not(:nth-child(2)) > a,
.site-nav > ul.nav-list:first-child > li > ul > li > ul > li > a {
  background-image: none;
}

.site-nav > ul.nav-list:not(:first-child) a,
.site-nav li.external a {
  background-image: none;
}

.site-nav > ul.nav-list:first-child > li:nth-child(4) > ul > li:nth-child(2) > a {
  font-weight: 600;
  text-decoration: none;
}.site-nav > ul.nav-list:first-child > li:nth-child(4) > button svg,
.site-nav > ul.nav-list:first-child > li:nth-child(4) > ul > li:nth-child(2) > button svg {
  transform: rotate(-90deg);
}.site-nav > ul.nav-list:first-child > li.nav-list-item:nth-child(4) > ul.nav-list,
.site-nav > ul.nav-list:first-child > li.nav-list-item:nth-child(4) > ul.nav-list > li.nav-list-item:nth-child(2) > ul.nav-list {
  display: block;
}
  </style>

  

  
    <script src="/assets/js/vendor/lunr.min.js"></script>
  

  <script src="/assets/js/just-the-docs.js"></script>

  <meta name="viewport" content="width=device-width, initial-scale=1">

  



  <!-- Begin Jekyll SEO tag v2.8.0 -->
<title>Options reference | aider</title>
<meta name="generator" content="Jekyll v3.10.0" />
<meta property="og:title" content="Options reference" />
<meta property="og:locale" content="en_US" />
<meta name="description" content="Details about all of aider’s settings." />
<meta property="og:description" content="Details about all of aider’s settings." />
<link rel="canonical" href="https://aider.chat/docs/config/options.html" />
<meta property="og:url" content="https://aider.chat/docs/config/options.html" />
<meta property="og:site_name" content="aider" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary" />
<meta property="twitter:title" content="Options reference" />
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"WebPage","description":"Details about all of aider’s settings.","headline":"Options reference","url":"https://aider.chat/docs/config/options.html"}</script>
<!-- End Jekyll SEO tag -->


  
<meta property="og:image" content="https://aider.chat/assets/aider.jpg">
<meta property="twitter:image" content="https://aider.chat/assets/aider-square.jpg">


<!-- Custom site title styling -->
<style>
  @font-face {
    font-family: GlassTTYVT220;
    src: local("Glass TTY VT220"), local("Glass TTY VT220 Medium"), url(/assets/Glass_TTY_VT220.ttf) format("truetype");
  }
  
  .site-title {
    font-size: 1.8rem;
    font-weight: 700;
    font-family: 'GlassTTYVT220', monospace;
    color: #14b014; /* terminal green color */
    text-decoration: none;
    letter-spacing: 0.5px;
  }
  
  /* For SVG logo inside site-title */
  .site-title img {
    height: 1.8rem;
    vertical-align: middle;
  }
 
  /* Sidebar gradient styling to match hero section */
  .side-bar { 
    background: linear-gradient(135deg, #ffffff 0%, rgba(20, 176, 20, 0.01) 25%, rgba(20, 176, 20, 0.04) 40%, rgba(220, 230, 255, 0.4) 60%, rgba(205, 218, 255, 0.4) 80%, #F5F6FA 100%);
  }

  @media (max-width: 50em) {
    .ea-ad--sidebar { display: none; }
    .ea-ad--mobile { display: block; }
  }
</style>
<link rel="alternate" type="application/rss+xml" title="RSS Feed" href="https://aider.chat/feed.xml">
<link rel="preconnect" href="https://fonts.gstatic.com">
<link rel="preload" href="https://fonts.googleapis.com/css?family=Open+Sans:400,700&display=swap" as="style" type="text/css" crossorigin>
<meta name="viewport" content="width=device-width, initial-scale=1">

<!-- Logo Progressive Enhancement for Jekyll pages -->
<script>
  document.addEventListener('DOMContentLoaded', function() {
    const siteTitle = document.querySelector('.site-title');
    if (siteTitle) {
      const textContent = siteTitle.textContent; // Save the text for fallback
      
      // Create new image element
      const logoImg = new Image();
      logoImg.src = '/assets/logo.svg';
      logoImg.alt = 'Aider Logo';
      logoImg.style.height = '1.8rem';
      logoImg.style.verticalAlign = 'middle';
      
      // Only replace if image loads successfully
      logoImg.onload = function() {
        siteTitle.textContent = ''; // Clear text
        siteTitle.appendChild(logoImg);
      };
      
      // If image fails to load, do nothing (keep the text)
      logoImg.onerror = function() {
        console.log('SVG logo failed to load, keeping text fallback');
      };
    }
  });
</script>
<meta name="theme-color" content="#157878">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" type="image/png" sizes="32x32" href="/assets/icons/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/assets/icons/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/assets/icons/apple-touch-icon.png">
<link rel="manifest" href="/assets/icons/site.webmanifest">
<link rel="mask-icon" href="/assets/icons/safari-pinned-tab.svg" color="#5bbad5">
<meta name="msapplication-TileColor" content="#da532c">
<meta name="theme-color" content="#ffffff">




</head>

<body>
  <a class="skip-to-main" href="#main-content">Skip to main content</a>
  <svg xmlns="http://www.w3.org/2000/svg" class="d-none">
  <symbol id="svg-link" viewBox="0 0 24 24">
  <title>Link</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-link">
    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path>
  </svg>
</symbol>

  <symbol id="svg-menu" viewBox="0 0 24 24">
  <title>Menu</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-menu">
    <line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="6" x2="21" y2="6"></line><line x1="3" y1="18" x2="21" y2="18"></line>
  </svg>
</symbol>

  <symbol id="svg-arrow-right" viewBox="0 0 24 24">
  <title>Expand</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-chevron-right">
    <polyline points="9 18 15 12 9 6"></polyline>
  </svg>
</symbol>

  <!-- Feather. MIT License: https://github.com/feathericons/feather/blob/master/LICENSE -->
<symbol id="svg-external-link" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-external-link">
  <title id="svg-external-link-title">(external link)</title>
  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>
</symbol>

  
    <symbol id="svg-doc" viewBox="0 0 24 24">
  <title>Document</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-file">
    <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline>
  </svg>
</symbol>

    <symbol id="svg-search" viewBox="0 0 24 24">
  <title>Search</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="feather feather-search">
    <circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>
  </svg>
</symbol>

  
  
    <!-- Bootstrap Icons. MIT License: https://github.com/twbs/icons/blob/main/LICENSE.md -->
<symbol id="svg-copy" viewBox="0 0 16 16">
  <title>Copy</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-clipboard" viewBox="0 0 16 16">
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1h1a1 1 0 0 1 1 1V14a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1h1v-1z"/>
    <path d="M9.5 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3zm-3-1A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3z"/>
  </svg>
</symbol>
<symbol id="svg-copied" viewBox="0 0 16 16">
  <title>Copied</title>
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-clipboard-check-fill" viewBox="0 0 16 16">
    <path d="M6.5 0A1.5 1.5 0 0 0 5 1.5v1A1.5 1.5 0 0 0 6.5 4h3A1.5 1.5 0 0 0 11 2.5v-1A1.5 1.5 0 0 0 9.5 0h-3Zm3 1a.5.5 0 0 1 .5.5v1a.5.5 0 0 1-.5.5h-3a.5.5 0 0 1-.5-.5v-1a.5.5 0 0 1 .5-.5h3Z"/>
    <path d="M4 1.5H3a2 2 0 0 0-2 2V14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V3.5a2 2 0 0 0-2-2h-1v1A2.5 2.5 0 0 1 9.5 5h-3A2.5 2.5 0 0 1 4 2.5v-1Zm6.854 7.354-3 3a.5.5 0 0 1-.708 0l-1.5-1.5a.5.5 0 0 1 .708-.708L7.5 10.793l2.646-2.647a.5.5 0 0 1 .708.708Z"/>
  </svg>
</symbol>

  
</svg>

  <div class="side-bar">
  <div class="site-header" role="banner">
    <a href="/" class="site-title lh-tight">
  aider

</a>
    <button id="menu-button" class="site-button btn-reset" aria-label="Toggle menu" aria-pressed="false">
      <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><use xlink:href="#svg-menu"></use></svg>
    </button>
  </div>

  <nav aria-label="Main" id="site-nav" class="site-nav">
  
  
    <ul class="nav-list"><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Installation category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/install.html" class="nav-list-link">Installation</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/install/optional.html" class="nav-list-link">Optional steps</a></li><li class="nav-list-item"><a href="/docs/install/docker.html" class="nav-list-link">Aider with docker</a></li><li class="nav-list-item"><a href="/docs/install/codespaces.html" class="nav-list-link">GitHub Codespaces</a></li><li class="nav-list-item"><a href="/docs/install/replit.html" class="nav-list-link">Replit</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Usage category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/usage.html" class="nav-list-link">Usage</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/usage/tips.html" class="nav-list-link">Tips</a></li><li class="nav-list-item"><a href="/docs/usage/commands.html" class="nav-list-link">In-chat commands</a></li><li class="nav-list-item"><a href="/docs/usage/modes.html" class="nav-list-link">Chat modes</a></li><li class="nav-list-item"><a href="/docs/usage/tutorials.html" class="nav-list-link">Tutorial videos</a></li><li class="nav-list-item"><a href="/docs/usage/voice.html" class="nav-list-link">Voice-to-code with aider</a></li><li class="nav-list-item"><a href="/docs/usage/images-urls.html" class="nav-list-link">Images &amp; web pages</a></li><li class="nav-list-item"><a href="/docs/usage/caching.html" class="nav-list-link">Prompt caching</a></li><li class="nav-list-item"><a href="/docs/usage/watch.html" class="nav-list-link">Aider in your IDE</a></li><li class="nav-list-item"><a href="/docs/usage/notifications.html" class="nav-list-link">Notifications</a></li><li class="nav-list-item"><a href="/docs/usage/browser.html" class="nav-list-link">Aider in your browser</a></li><li class="nav-list-item"><a href="/docs/usage/conventions.html" class="nav-list-link">Specifying coding conventions</a></li><li class="nav-list-item"><a href="/docs/usage/copypaste.html" class="nav-list-link">Copy/paste with web chat</a></li><li class="nav-list-item"><a href="/docs/usage/lint-test.html" class="nav-list-link">Linting and testing</a></li><li class="nav-list-item"><a href="/docs/usage/not-code.html" class="nav-list-link">Editing config &amp; text files</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Connecting to LLMs category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/llms.html" class="nav-list-link">Connecting to LLMs</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/llms/openai.html" class="nav-list-link">OpenAI</a></li><li class="nav-list-item"><a href="/docs/llms/anthropic.html" class="nav-list-link">Anthropic</a></li><li class="nav-list-item"><a href="/docs/llms/gemini.html" class="nav-list-link">Gemini</a></li><li class="nav-list-item"><a href="/docs/llms/groq.html" class="nav-list-link">GROQ</a></li><li class="nav-list-item"><a href="/docs/llms/lm-studio.html" class="nav-list-link">LM Studio</a></li><li class="nav-list-item"><a href="/docs/llms/xai.html" class="nav-list-link">xAI</a></li><li class="nav-list-item"><a href="/docs/llms/azure.html" class="nav-list-link">Azure</a></li><li class="nav-list-item"><a href="/docs/llms/cohere.html" class="nav-list-link">Cohere</a></li><li class="nav-list-item"><a href="/docs/llms/deepseek.html" class="nav-list-link">DeepSeek</a></li><li class="nav-list-item"><a href="/docs/llms/ollama.html" class="nav-list-link">Ollama</a></li><li class="nav-list-item"><a href="/docs/llms/openai-compat.html" class="nav-list-link">OpenAI compatible APIs</a></li><li class="nav-list-item"><a href="/docs/llms/openrouter.html" class="nav-list-link">OpenRouter</a></li><li class="nav-list-item"><a href="/docs/llms/github.html" class="nav-list-link">GitHub Copilot</a></li><li class="nav-list-item"><a href="/docs/llms/vertex.html" class="nav-list-link">Vertex AI</a></li><li class="nav-list-item"><a href="/docs/llms/bedrock.html" class="nav-list-link">Amazon Bedrock</a></li><li class="nav-list-item"><a href="/docs/llms/other.html" class="nav-list-link">Other LLMs</a></li><li class="nav-list-item"><a href="/docs/llms/warnings.html" class="nav-list-link">Model warnings</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Configuration category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/config.html" class="nav-list-link">Configuration</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/config/api-keys.html" class="nav-list-link">API Keys</a></li><li class="nav-list-item"><a href="/docs/config/options.html" class="nav-list-link">Options reference</a></li><li class="nav-list-item"><a href="/docs/config/aider_conf.html" class="nav-list-link">YAML config file</a></li><li class="nav-list-item"><a href="/docs/config/dotenv.html" class="nav-list-link">Config with .env</a></li><li class="nav-list-item"><a href="/docs/config/editor.html" class="nav-list-link">Editor configuration</a></li><li class="nav-list-item"><a href="/docs/config/reasoning.html" class="nav-list-link">Reasoning models</a></li><li class="nav-list-item"><a href="/docs/config/adv-model-settings.html" class="nav-list-link">Advanced model settings</a></li><li class="nav-list-item"><a href="/docs/config/model-aliases.html" class="nav-list-link">Model Aliases</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Troubleshooting category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/troubleshooting.html" class="nav-list-link">Troubleshooting</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/troubleshooting/edit-errors.html" class="nav-list-link">File editing problems</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/warnings.html" class="nav-list-link">Model warnings</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/token-limits.html" class="nav-list-link">Token limits</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/aider-not-found.html" class="nav-list-link">Aider not found</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/imports.html" class="nav-list-link">Dependency versions</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/models-and-keys.html" class="nav-list-link">Models and API keys</a></li><li class="nav-list-item"><a href="/docs/troubleshooting/support.html" class="nav-list-link">Using /help</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Screen recordings category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/recordings/" class="nav-list-link">Screen recordings</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/recordings/tree-sitter-language-pack.html" class="nav-list-link">Add language support via tree-sitter-language-pack</a></li><li class="nav-list-item"><a href="/docs/recordings/auto-accept-architect.html" class="nav-list-link">Add –auto-accept-architect feature</a></li><li class="nav-list-item"><a href="/docs/recordings/dont-drop-original-read-files.html" class="nav-list-link">Don’t /drop read-only files added at launch</a></li><li class="nav-list-item"><a href="/docs/recordings/model-accepts-settings.html" class="nav-list-link">Warn when users apply unsupported reasoning settings</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Example chat transcripts category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/examples/README.html" class="nav-list-link">Example chat transcripts</a><ul class="nav-list"><li class="nav-list-item"><a href="/examples/hello-world-flask.html" class="nav-list-link">Create a simple flask app with aider</a></li><li class="nav-list-item"><a href="/examples/2048-game.html" class="nav-list-link">Modify an open source 2048 game with aider</a></li><li class="nav-list-item"><a href="/examples/complex-change.html" class="nav-list-link">A complex multi-file change, with debugging</a></li><li class="nav-list-item"><a href="/examples/add-test.html" class="nav-list-link">Create a “black box” test case</a></li><li class="nav-list-item"><a href="/examples/update-docs.html" class="nav-list-link">Automatically update docs with aider</a></li><li class="nav-list-item"><a href="/examples/pong.html" class="nav-list-link">Build pong with aider and pygame.</a></li><li class="nav-list-item"><a href="/examples/css-exercises.html" class="nav-list-link">Complete a css exercise with aider</a></li><li class="nav-list-item"><a href="/examples/census.html" class="nav-list-link">Download, analyze and plot US Census data</a></li><li class="nav-list-item"><a href="/examples/asciinema.html" class="nav-list-link">Editing an asciinema cast file with aider</a></li><li class="nav-list-item"><a href="/examples/hello.html" class="nav-list-link">Hello aider!</a></li><li class="nav-list-item"><a href="/examples/no-color.html" class="nav-list-link">Honor the NO_COLOR environment variable</a></li><li class="nav-list-item"><a href="/examples/chat-transcript-css.html" class="nav-list-link">Improve css styling of chat transcripts</a></li><li class="nav-list-item"><a href="/examples/semantic-search-replace.html" class="nav-list-link">Semantic search &amp; replace code with aider</a></li></ul></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in More info category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/more-info.html" class="nav-list-link">More info</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/git.html" class="nav-list-link">Git integration</a></li><li class="nav-list-item"><a href="/docs/languages.html" class="nav-list-link">Supported languages</a></li><li class="nav-list-item"><a href="/docs/repomap.html" class="nav-list-link">Repository map</a></li><li class="nav-list-item"><a href="/docs/scripting.html" class="nav-list-link">Scripting aider</a></li><li class="nav-list-item"><a href="/docs/more/infinite-output.html" class="nav-list-link">Infinite output</a></li><li class="nav-list-item"><a href="/docs/more/edit-formats.html" class="nav-list-link">Edit formats</a></li><li class="nav-list-item"><a href="/docs/more/analytics.html" class="nav-list-link">Analytics</a></li><li class="nav-list-item"><a href="/docs/legal/privacy.html" class="nav-list-link">Privacy policy</a></li></ul></li><li class="nav-list-item"><a href="/docs/faq.html" class="nav-list-link">FAQ</a></li><li class="nav-list-item"><a href="/HISTORY.html" class="nav-list-link">Release history</a></li><li class="nav-list-item"><button class="nav-list-expander btn-reset" aria-label="toggle items in Aider LLM Leaderboards category" aria-pressed="false">
      <svg viewBox="0 0 24 24" aria-hidden="true"><use xlink:href="#svg-arrow-right"></use></svg>
    </button><a href="/docs/leaderboards/" class="nav-list-link">Aider LLM Leaderboards</a><ul class="nav-list"><li class="nav-list-item"><a href="/docs/leaderboards/edit.html" class="nav-list-link">Code editing leaderboard</a></li><li class="nav-list-item"><a href="/docs/leaderboards/refactor.html" class="nav-list-link">Refactoring leaderboard</a></li><li class="nav-list-item"><a href="/docs/leaderboards/by-release-date.html" class="nav-list-link">Scores by release date</a></li><li class="nav-list-item"><a href="/docs/leaderboards/notes.html" class="nav-list-link">Benchmark notes</a></li><li class="nav-list-item"><a href="/docs/leaderboards/contrib.html" class="nav-list-link">Contributing results</a></li></ul></li><li class="nav-list-item"><a href="/blog/" class="nav-list-link">Aider blog</a></li></ul>

  <ul class="nav-list"><li class="nav-list-item external">
          <a href="https://github.com/Aider-AI/aider" class="nav-list-link external"
            
          >
            GitHub
            <svg viewBox="0 0 24 24" aria-labelledby="svg-external-link-title"><use xlink:href="#svg-external-link"></use></svg>
          </a>
        </li><li class="nav-list-item external">
          <a href="https://discord.gg/Y7X7bhMQFV" class="nav-list-link external"
            
          >
            Discord
            <svg viewBox="0 0 24 24" aria-labelledby="svg-external-link-title"><use xlink:href="#svg-external-link"></use></svg>
          </a>
        </li></ul>
</nav>


  
  
    <footer class="site-footer">
    Aider is AI pair programming in your terminal.
    Aider is on
    <a href="https://github.com/Aider-AI/aider">GitHub</a>
    and
    <a href="https://discord.gg/Y7X7bhMQFV">Discord</a>.
</footer>

  
</div>

  <div class="main" id="top">
    <div id="main-header" class="main-header">
  
    

<div class="search" role="search">
  <div class="search-input-wrap">
    <input type="text" id="search-input" class="search-input" tabindex="0" placeholder="Search aider" aria-label="Search aider" autocomplete="off">
    <label for="search-input" class="search-label"><svg viewBox="0 0 24 24" class="search-icon"><use xlink:href="#svg-search"></use></svg></label>
  </div>
  <div id="search-results" class="search-results"></div>
</div>

  
  
  
    <nav aria-label="Auxiliary" class="aux-nav">
  <ul class="aux-nav-list">
    
      <li class="aux-nav-list-item">
        <a href="https://github.com/Aider-AI/aider" class="site-button"
          
        >
          GitHub
        </a>
      </li>
    
      <li class="aux-nav-list-item">
        <a href="https://discord.gg/Y7X7bhMQFV" class="site-button"
          
        >
          Discord
        </a>
      </li>
    
      <li class="aux-nav-list-item">
        <a href="/blog/" class="site-button"
          
        >
          Blog
        </a>
      </li>
    
  </ul>
</nav>

  
</div>

    <div class="main-content-wrap">
      <nav aria-label="Breadcrumb" class="breadcrumb-nav">
  <ol class="breadcrumb-nav-list">
    <li class="breadcrumb-nav-list-item"><a href="/docs/config.html">Configuration</a></li>
    <li class="breadcrumb-nav-list-item"><span>Options reference</span></li>
  </ol>
</nav>
      <div id="main-content" class="main-content">
        <main>
          
            <h1 class="no_toc" id="options-reference">
  
  
    <a href="#options-reference" class="anchor-heading" aria-labelledby="options-reference"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Options reference
  
  
</h1>
    

<p>You can use <code class="language-plaintext highlighter-rouge">aider --help</code> to see all the available options,
or review them below.</p>

<ul id="markdown-toc">
  <li><a href="#usage-summary" id="markdown-toc-usage-summary">Usage summary</a></li>
  <li><a href="#options" id="markdown-toc-options">options:</a>    <ul>
      <li><a href="#--help" id="markdown-toc---help"><code class="language-plaintext highlighter-rouge">--help</code></a></li>
    </ul>
  </li>
  <li><a href="#main-model" id="markdown-toc-main-model">Main model:</a>    <ul>
      <li><a href="#--model-model" id="markdown-toc---model-model"><code class="language-plaintext highlighter-rouge">--model MODEL</code></a></li>
    </ul>
  </li>
  <li><a href="#api-keys-and-settings" id="markdown-toc-api-keys-and-settings">API Keys and settings:</a>    <ul>
      <li><a href="#--openai-api-key-value" id="markdown-toc---openai-api-key-value"><code class="language-plaintext highlighter-rouge">--openai-api-key VALUE</code></a></li>
      <li><a href="#--anthropic-api-key-value" id="markdown-toc---anthropic-api-key-value"><code class="language-plaintext highlighter-rouge">--anthropic-api-key VALUE</code></a></li>
      <li><a href="#--openai-api-base-value" id="markdown-toc---openai-api-base-value"><code class="language-plaintext highlighter-rouge">--openai-api-base VALUE</code></a></li>
      <li><a href="#--openai-api-type-value" id="markdown-toc---openai-api-type-value"><code class="language-plaintext highlighter-rouge">--openai-api-type VALUE</code></a></li>
      <li><a href="#--openai-api-version-value" id="markdown-toc---openai-api-version-value"><code class="language-plaintext highlighter-rouge">--openai-api-version VALUE</code></a></li>
      <li><a href="#--openai-api-deployment-id-value" id="markdown-toc---openai-api-deployment-id-value"><code class="language-plaintext highlighter-rouge">--openai-api-deployment-id VALUE</code></a></li>
      <li><a href="#--openai-organization-id-value" id="markdown-toc---openai-organization-id-value"><code class="language-plaintext highlighter-rouge">--openai-organization-id VALUE</code></a></li>
      <li><a href="#--set-env-env_var_namevalue" id="markdown-toc---set-env-env_var_namevalue"><code class="language-plaintext highlighter-rouge">--set-env ENV_VAR_NAME=value</code></a></li>
      <li><a href="#--api-key-providerkey" id="markdown-toc---api-key-providerkey"><code class="language-plaintext highlighter-rouge">--api-key PROVIDER=KEY</code></a></li>
    </ul>
  </li>
  <li><a href="#model-settings" id="markdown-toc-model-settings">Model settings:</a>    <ul>
      <li><a href="#--list-models-model" id="markdown-toc---list-models-model"><code class="language-plaintext highlighter-rouge">--list-models MODEL</code></a></li>
      <li><a href="#--model-settings-file-model_settings_file" id="markdown-toc---model-settings-file-model_settings_file"><code class="language-plaintext highlighter-rouge">--model-settings-file MODEL_SETTINGS_FILE</code></a></li>
      <li><a href="#--model-metadata-file-model_metadata_file" id="markdown-toc---model-metadata-file-model_metadata_file"><code class="language-plaintext highlighter-rouge">--model-metadata-file MODEL_METADATA_FILE</code></a></li>
      <li><a href="#--alias-aliasmodel" id="markdown-toc---alias-aliasmodel"><code class="language-plaintext highlighter-rouge">--alias ALIAS:MODEL</code></a></li>
      <li><a href="#--reasoning-effort-value" id="markdown-toc---reasoning-effort-value"><code class="language-plaintext highlighter-rouge">--reasoning-effort VALUE</code></a></li>
      <li><a href="#--thinking-tokens-value" id="markdown-toc---thinking-tokens-value"><code class="language-plaintext highlighter-rouge">--thinking-tokens VALUE</code></a></li>
      <li><a href="#--verify-ssl" id="markdown-toc---verify-ssl"><code class="language-plaintext highlighter-rouge">--verify-ssl</code></a></li>
      <li><a href="#--timeout-value" id="markdown-toc---timeout-value"><code class="language-plaintext highlighter-rouge">--timeout VALUE</code></a></li>
      <li><a href="#--edit-format-edit_format" id="markdown-toc---edit-format-edit_format"><code class="language-plaintext highlighter-rouge">--edit-format EDIT_FORMAT</code></a></li>
      <li><a href="#--architect" id="markdown-toc---architect"><code class="language-plaintext highlighter-rouge">--architect</code></a></li>
      <li><a href="#--auto-accept-architect" id="markdown-toc---auto-accept-architect"><code class="language-plaintext highlighter-rouge">--auto-accept-architect</code></a></li>
      <li><a href="#--weak-model-weak_model" id="markdown-toc---weak-model-weak_model"><code class="language-plaintext highlighter-rouge">--weak-model WEAK_MODEL</code></a></li>
      <li><a href="#--editor-model-editor_model" id="markdown-toc---editor-model-editor_model"><code class="language-plaintext highlighter-rouge">--editor-model EDITOR_MODEL</code></a></li>
      <li><a href="#--editor-edit-format-editor_edit_format" id="markdown-toc---editor-edit-format-editor_edit_format"><code class="language-plaintext highlighter-rouge">--editor-edit-format EDITOR_EDIT_FORMAT</code></a></li>
      <li><a href="#--show-model-warnings" id="markdown-toc---show-model-warnings"><code class="language-plaintext highlighter-rouge">--show-model-warnings</code></a></li>
      <li><a href="#--check-model-accepts-settings" id="markdown-toc---check-model-accepts-settings"><code class="language-plaintext highlighter-rouge">--check-model-accepts-settings</code></a></li>
      <li><a href="#--max-chat-history-tokens-value" id="markdown-toc---max-chat-history-tokens-value"><code class="language-plaintext highlighter-rouge">--max-chat-history-tokens VALUE</code></a></li>
    </ul>
  </li>
  <li><a href="#cache-settings" id="markdown-toc-cache-settings">Cache settings:</a>    <ul>
      <li><a href="#--cache-prompts" id="markdown-toc---cache-prompts"><code class="language-plaintext highlighter-rouge">--cache-prompts</code></a></li>
      <li><a href="#--cache-keepalive-pings-value" id="markdown-toc---cache-keepalive-pings-value"><code class="language-plaintext highlighter-rouge">--cache-keepalive-pings VALUE</code></a></li>
    </ul>
  </li>
  <li><a href="#repomap-settings" id="markdown-toc-repomap-settings">Repomap settings:</a>    <ul>
      <li><a href="#--map-tokens-value" id="markdown-toc---map-tokens-value"><code class="language-plaintext highlighter-rouge">--map-tokens VALUE</code></a></li>
      <li><a href="#--map-refresh-value" id="markdown-toc---map-refresh-value"><code class="language-plaintext highlighter-rouge">--map-refresh VALUE</code></a></li>
      <li><a href="#--map-multiplier-no-files-value" id="markdown-toc---map-multiplier-no-files-value"><code class="language-plaintext highlighter-rouge">--map-multiplier-no-files VALUE</code></a></li>
    </ul>
  </li>
  <li><a href="#history-files" id="markdown-toc-history-files">History Files:</a>    <ul>
      <li><a href="#--input-history-file-input_history_file" id="markdown-toc---input-history-file-input_history_file"><code class="language-plaintext highlighter-rouge">--input-history-file INPUT_HISTORY_FILE</code></a></li>
      <li><a href="#--chat-history-file-chat_history_file" id="markdown-toc---chat-history-file-chat_history_file"><code class="language-plaintext highlighter-rouge">--chat-history-file CHAT_HISTORY_FILE</code></a></li>
      <li><a href="#--restore-chat-history" id="markdown-toc---restore-chat-history"><code class="language-plaintext highlighter-rouge">--restore-chat-history</code></a></li>
      <li><a href="#--llm-history-file-llm_history_file" id="markdown-toc---llm-history-file-llm_history_file"><code class="language-plaintext highlighter-rouge">--llm-history-file LLM_HISTORY_FILE</code></a></li>
    </ul>
  </li>
  <li><a href="#output-settings" id="markdown-toc-output-settings">Output settings:</a>    <ul>
      <li><a href="#--dark-mode" id="markdown-toc---dark-mode"><code class="language-plaintext highlighter-rouge">--dark-mode</code></a></li>
      <li><a href="#--light-mode" id="markdown-toc---light-mode"><code class="language-plaintext highlighter-rouge">--light-mode</code></a></li>
      <li><a href="#--pretty" id="markdown-toc---pretty"><code class="language-plaintext highlighter-rouge">--pretty</code></a></li>
      <li><a href="#--stream" id="markdown-toc---stream"><code class="language-plaintext highlighter-rouge">--stream</code></a></li>
      <li><a href="#--user-input-color-value" id="markdown-toc---user-input-color-value"><code class="language-plaintext highlighter-rouge">--user-input-color VALUE</code></a></li>
      <li><a href="#--tool-output-color-value" id="markdown-toc---tool-output-color-value"><code class="language-plaintext highlighter-rouge">--tool-output-color VALUE</code></a></li>
      <li><a href="#--tool-error-color-value" id="markdown-toc---tool-error-color-value"><code class="language-plaintext highlighter-rouge">--tool-error-color VALUE</code></a></li>
      <li><a href="#--tool-warning-color-value" id="markdown-toc---tool-warning-color-value"><code class="language-plaintext highlighter-rouge">--tool-warning-color VALUE</code></a></li>
      <li><a href="#--assistant-output-color-value" id="markdown-toc---assistant-output-color-value"><code class="language-plaintext highlighter-rouge">--assistant-output-color VALUE</code></a></li>
      <li><a href="#--completion-menu-color-color" id="markdown-toc---completion-menu-color-color"><code class="language-plaintext highlighter-rouge">--completion-menu-color COLOR</code></a></li>
      <li><a href="#--completion-menu-bg-color-color" id="markdown-toc---completion-menu-bg-color-color"><code class="language-plaintext highlighter-rouge">--completion-menu-bg-color COLOR</code></a></li>
      <li><a href="#--completion-menu-current-color-color" id="markdown-toc---completion-menu-current-color-color"><code class="language-plaintext highlighter-rouge">--completion-menu-current-color COLOR</code></a></li>
      <li><a href="#--completion-menu-current-bg-color-color" id="markdown-toc---completion-menu-current-bg-color-color"><code class="language-plaintext highlighter-rouge">--completion-menu-current-bg-color COLOR</code></a></li>
      <li><a href="#--code-theme-value" id="markdown-toc---code-theme-value"><code class="language-plaintext highlighter-rouge">--code-theme VALUE</code></a></li>
      <li><a href="#--show-diffs" id="markdown-toc---show-diffs"><code class="language-plaintext highlighter-rouge">--show-diffs</code></a></li>
    </ul>
  </li>
  <li><a href="#git-settings" id="markdown-toc-git-settings">Git settings:</a>    <ul>
      <li><a href="#--git" id="markdown-toc---git"><code class="language-plaintext highlighter-rouge">--git</code></a></li>
      <li><a href="#--gitignore" id="markdown-toc---gitignore"><code class="language-plaintext highlighter-rouge">--gitignore</code></a></li>
      <li><a href="#--add-gitignore-files" id="markdown-toc---add-gitignore-files"><code class="language-plaintext highlighter-rouge">--add-gitignore-files</code></a></li>
      <li><a href="#--aiderignore-aiderignore" id="markdown-toc---aiderignore-aiderignore"><code class="language-plaintext highlighter-rouge">--aiderignore AIDERIGNORE</code></a></li>
      <li><a href="#--subtree-only" id="markdown-toc---subtree-only"><code class="language-plaintext highlighter-rouge">--subtree-only</code></a></li>
      <li><a href="#--auto-commits" id="markdown-toc---auto-commits"><code class="language-plaintext highlighter-rouge">--auto-commits</code></a></li>
      <li><a href="#--dirty-commits" id="markdown-toc---dirty-commits"><code class="language-plaintext highlighter-rouge">--dirty-commits</code></a></li>
      <li><a href="#--attribute-author" id="markdown-toc---attribute-author"><code class="language-plaintext highlighter-rouge">--attribute-author</code></a></li>
      <li><a href="#--attribute-committer" id="markdown-toc---attribute-committer"><code class="language-plaintext highlighter-rouge">--attribute-committer</code></a></li>
      <li><a href="#--attribute-commit-message-author" id="markdown-toc---attribute-commit-message-author"><code class="language-plaintext highlighter-rouge">--attribute-commit-message-author</code></a></li>
      <li><a href="#--attribute-commit-message-committer" id="markdown-toc---attribute-commit-message-committer"><code class="language-plaintext highlighter-rouge">--attribute-commit-message-committer</code></a></li>
      <li><a href="#--attribute-co-authored-by" id="markdown-toc---attribute-co-authored-by"><code class="language-plaintext highlighter-rouge">--attribute-co-authored-by</code></a></li>
      <li><a href="#--git-commit-verify" id="markdown-toc---git-commit-verify"><code class="language-plaintext highlighter-rouge">--git-commit-verify</code></a></li>
      <li><a href="#--commit" id="markdown-toc---commit"><code class="language-plaintext highlighter-rouge">--commit</code></a></li>
      <li><a href="#--commit-prompt-prompt" id="markdown-toc---commit-prompt-prompt"><code class="language-plaintext highlighter-rouge">--commit-prompt PROMPT</code></a></li>
      <li><a href="#--dry-run" id="markdown-toc---dry-run"><code class="language-plaintext highlighter-rouge">--dry-run</code></a></li>
      <li><a href="#--skip-sanity-check-repo" id="markdown-toc---skip-sanity-check-repo"><code class="language-plaintext highlighter-rouge">--skip-sanity-check-repo</code></a></li>
      <li><a href="#--watch-files" id="markdown-toc---watch-files"><code class="language-plaintext highlighter-rouge">--watch-files</code></a></li>
    </ul>
  </li>
  <li><a href="#fixing-and-committing" id="markdown-toc-fixing-and-committing">Fixing and committing:</a>    <ul>
      <li><a href="#--lint" id="markdown-toc---lint"><code class="language-plaintext highlighter-rouge">--lint</code></a></li>
      <li><a href="#--lint-cmd" id="markdown-toc---lint-cmd"><code class="language-plaintext highlighter-rouge">--lint-cmd</code></a></li>
      <li><a href="#--auto-lint" id="markdown-toc---auto-lint"><code class="language-plaintext highlighter-rouge">--auto-lint</code></a></li>
      <li><a href="#--test-cmd-value" id="markdown-toc---test-cmd-value"><code class="language-plaintext highlighter-rouge">--test-cmd VALUE</code></a></li>
      <li><a href="#--auto-test" id="markdown-toc---auto-test"><code class="language-plaintext highlighter-rouge">--auto-test</code></a></li>
      <li><a href="#--test" id="markdown-toc---test"><code class="language-plaintext highlighter-rouge">--test</code></a></li>
    </ul>
  </li>
  <li><a href="#analytics" id="markdown-toc-analytics">Analytics:</a>    <ul>
      <li><a href="#--analytics" id="markdown-toc---analytics"><code class="language-plaintext highlighter-rouge">--analytics</code></a></li>
      <li><a href="#--analytics-log-analytics_log_file" id="markdown-toc---analytics-log-analytics_log_file"><code class="language-plaintext highlighter-rouge">--analytics-log ANALYTICS_LOG_FILE</code></a></li>
      <li><a href="#--analytics-disable" id="markdown-toc---analytics-disable"><code class="language-plaintext highlighter-rouge">--analytics-disable</code></a></li>
      <li><a href="#--analytics-posthog-host-analytics_posthog_host" id="markdown-toc---analytics-posthog-host-analytics_posthog_host"><code class="language-plaintext highlighter-rouge">--analytics-posthog-host ANALYTICS_POSTHOG_HOST</code></a></li>
      <li><a href="#--analytics-posthog-project-api-key-analytics_posthog_project_api_key" id="markdown-toc---analytics-posthog-project-api-key-analytics_posthog_project_api_key"><code class="language-plaintext highlighter-rouge">--analytics-posthog-project-api-key ANALYTICS_POSTHOG_PROJECT_API_KEY</code></a></li>
    </ul>
  </li>
  <li><a href="#upgrading" id="markdown-toc-upgrading">Upgrading:</a>    <ul>
      <li><a href="#--just-check-update" id="markdown-toc---just-check-update"><code class="language-plaintext highlighter-rouge">--just-check-update</code></a></li>
      <li><a href="#--check-update" id="markdown-toc---check-update"><code class="language-plaintext highlighter-rouge">--check-update</code></a></li>
      <li><a href="#--show-release-notes" id="markdown-toc---show-release-notes"><code class="language-plaintext highlighter-rouge">--show-release-notes</code></a></li>
      <li><a href="#--install-main-branch" id="markdown-toc---install-main-branch"><code class="language-plaintext highlighter-rouge">--install-main-branch</code></a></li>
      <li><a href="#--upgrade" id="markdown-toc---upgrade"><code class="language-plaintext highlighter-rouge">--upgrade</code></a></li>
      <li><a href="#--version" id="markdown-toc---version"><code class="language-plaintext highlighter-rouge">--version</code></a></li>
    </ul>
  </li>
  <li><a href="#modes" id="markdown-toc-modes">Modes:</a>    <ul>
      <li><a href="#--message-command" id="markdown-toc---message-command"><code class="language-plaintext highlighter-rouge">--message COMMAND</code></a></li>
      <li><a href="#--message-file-message_file" id="markdown-toc---message-file-message_file"><code class="language-plaintext highlighter-rouge">--message-file MESSAGE_FILE</code></a></li>
      <li><a href="#--gui" id="markdown-toc---gui"><code class="language-plaintext highlighter-rouge">--gui</code></a></li>
      <li><a href="#--copy-paste" id="markdown-toc---copy-paste"><code class="language-plaintext highlighter-rouge">--copy-paste</code></a></li>
      <li><a href="#--apply-file" id="markdown-toc---apply-file"><code class="language-plaintext highlighter-rouge">--apply FILE</code></a></li>
      <li><a href="#--apply-clipboard-edits" id="markdown-toc---apply-clipboard-edits"><code class="language-plaintext highlighter-rouge">--apply-clipboard-edits</code></a></li>
      <li><a href="#--exit" id="markdown-toc---exit"><code class="language-plaintext highlighter-rouge">--exit</code></a></li>
      <li><a href="#--show-repo-map" id="markdown-toc---show-repo-map"><code class="language-plaintext highlighter-rouge">--show-repo-map</code></a></li>
      <li><a href="#--show-prompts" id="markdown-toc---show-prompts"><code class="language-plaintext highlighter-rouge">--show-prompts</code></a></li>
    </ul>
  </li>
  <li><a href="#voice-settings" id="markdown-toc-voice-settings">Voice settings:</a>    <ul>
      <li><a href="#--voice-format-voice_format" id="markdown-toc---voice-format-voice_format"><code class="language-plaintext highlighter-rouge">--voice-format VOICE_FORMAT</code></a></li>
      <li><a href="#--voice-language-voice_language" id="markdown-toc---voice-language-voice_language"><code class="language-plaintext highlighter-rouge">--voice-language VOICE_LANGUAGE</code></a></li>
      <li><a href="#--voice-input-device-voice_input_device" id="markdown-toc---voice-input-device-voice_input_device"><code class="language-plaintext highlighter-rouge">--voice-input-device VOICE_INPUT_DEVICE</code></a></li>
    </ul>
  </li>
  <li><a href="#other-settings" id="markdown-toc-other-settings">Other settings:</a>    <ul>
      <li><a href="#--disable-playwright" id="markdown-toc---disable-playwright"><code class="language-plaintext highlighter-rouge">--disable-playwright</code></a></li>
      <li><a href="#--file-file" id="markdown-toc---file-file"><code class="language-plaintext highlighter-rouge">--file FILE</code></a></li>
      <li><a href="#--read-file" id="markdown-toc---read-file"><code class="language-plaintext highlighter-rouge">--read FILE</code></a></li>
      <li><a href="#--vim" id="markdown-toc---vim"><code class="language-plaintext highlighter-rouge">--vim</code></a></li>
      <li><a href="#--chat-language-chat_language" id="markdown-toc---chat-language-chat_language"><code class="language-plaintext highlighter-rouge">--chat-language CHAT_LANGUAGE</code></a></li>
      <li><a href="#--commit-language-commit_language" id="markdown-toc---commit-language-commit_language"><code class="language-plaintext highlighter-rouge">--commit-language COMMIT_LANGUAGE</code></a></li>
      <li><a href="#--yes-always" id="markdown-toc---yes-always"><code class="language-plaintext highlighter-rouge">--yes-always</code></a></li>
      <li><a href="#--verbose" id="markdown-toc---verbose"><code class="language-plaintext highlighter-rouge">--verbose</code></a></li>
      <li><a href="#--load-load_file" id="markdown-toc---load-load_file"><code class="language-plaintext highlighter-rouge">--load LOAD_FILE</code></a></li>
      <li><a href="#--encoding-value" id="markdown-toc---encoding-value"><code class="language-plaintext highlighter-rouge">--encoding VALUE</code></a></li>
      <li><a href="#--line-endings-value" id="markdown-toc---line-endings-value"><code class="language-plaintext highlighter-rouge">--line-endings VALUE</code></a></li>
      <li><a href="#--config-config_file" id="markdown-toc---config-config_file"><code class="language-plaintext highlighter-rouge">--config CONFIG_FILE</code></a></li>
      <li><a href="#--env-file-env_file" id="markdown-toc---env-file-env_file"><code class="language-plaintext highlighter-rouge">--env-file ENV_FILE</code></a></li>
      <li><a href="#--suggest-shell-commands" id="markdown-toc---suggest-shell-commands"><code class="language-plaintext highlighter-rouge">--suggest-shell-commands</code></a></li>
      <li><a href="#--fancy-input" id="markdown-toc---fancy-input"><code class="language-plaintext highlighter-rouge">--fancy-input</code></a></li>
      <li><a href="#--multiline" id="markdown-toc---multiline"><code class="language-plaintext highlighter-rouge">--multiline</code></a></li>
      <li><a href="#--notifications" id="markdown-toc---notifications"><code class="language-plaintext highlighter-rouge">--notifications</code></a></li>
      <li><a href="#--notifications-command-command" id="markdown-toc---notifications-command-command"><code class="language-plaintext highlighter-rouge">--notifications-command COMMAND</code></a></li>
      <li><a href="#--detect-urls" id="markdown-toc---detect-urls"><code class="language-plaintext highlighter-rouge">--detect-urls</code></a></li>
      <li><a href="#--editor-value" id="markdown-toc---editor-value"><code class="language-plaintext highlighter-rouge">--editor VALUE</code></a></li>
      <li><a href="#--shell-completions-shell" id="markdown-toc---shell-completions-shell"><code class="language-plaintext highlighter-rouge">--shell-completions SHELL</code></a></li>
    </ul>
  </li>
  <li><a href="#deprecated-model-settings" id="markdown-toc-deprecated-model-settings">Deprecated model settings:</a>    <ul>
      <li><a href="#--opus" id="markdown-toc---opus"><code class="language-plaintext highlighter-rouge">--opus</code></a></li>
      <li><a href="#--sonnet" id="markdown-toc---sonnet"><code class="language-plaintext highlighter-rouge">--sonnet</code></a></li>
      <li><a href="#--haiku" id="markdown-toc---haiku"><code class="language-plaintext highlighter-rouge">--haiku</code></a></li>
      <li><a href="#--4" id="markdown-toc---4"><code class="language-plaintext highlighter-rouge">--4</code></a></li>
      <li><a href="#--4o" id="markdown-toc---4o"><code class="language-plaintext highlighter-rouge">--4o</code></a></li>
      <li><a href="#--mini" id="markdown-toc---mini"><code class="language-plaintext highlighter-rouge">--mini</code></a></li>
      <li><a href="#--4-turbo" id="markdown-toc---4-turbo"><code class="language-plaintext highlighter-rouge">--4-turbo</code></a></li>
      <li><a href="#--35turbo" id="markdown-toc---35turbo"><code class="language-plaintext highlighter-rouge">--35turbo</code></a></li>
      <li><a href="#--deepseek" id="markdown-toc---deepseek"><code class="language-plaintext highlighter-rouge">--deepseek</code></a></li>
      <li><a href="#--o1-mini" id="markdown-toc---o1-mini"><code class="language-plaintext highlighter-rouge">--o1-mini</code></a></li>
      <li><a href="#--o1-preview" id="markdown-toc---o1-preview"><code class="language-plaintext highlighter-rouge">--o1-preview</code></a></li>
    </ul>
  </li>
</ul>

<p class="tip">See the
<a href="/docs/config/api-keys.html">API key configuration docs</a>
for information on how to configure and store your API keys.</p>
<h2 id="usage-summary">
  
  
    <a href="#usage-summary" class="anchor-heading" aria-labelledby="usage-summary"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Usage summary
  
  
</h2>
    

<!--[[[cog
from aider.args import get_md_help
cog.out(get_md_help())
]]]-->
<div class="language-plaintext highlighter-rouge"><div class="highlight"><pre class="highlight"><code>usage: aider [-h] [--model] [--openai-api-key] [--anthropic-api-key]
             [--openai-api-base] [--openai-api-type]
             [--openai-api-version] [--openai-api-deployment-id]
             [--openai-organization-id] [--set-env] [--api-key]
             [--list-models] [--model-settings-file]
             [--model-metadata-file] [--alias] [--reasoning-effort]
             [--thinking-tokens] [--verify-ssl | --no-verify-ssl]
             [--timeout] [--edit-format] [--architect]
             [--auto-accept-architect | --no-auto-accept-architect]
             [--weak-model] [--editor-model] [--editor-edit-format]
             [--show-model-warnings | --no-show-model-warnings]
             [--check-model-accepts-settings | --no-check-model-accepts-settings]
             [--max-chat-history-tokens]
             [--cache-prompts | --no-cache-prompts]
             [--cache-keepalive-pings] [--map-tokens]
             [--map-refresh] [--map-multiplier-no-files]
             [--input-history-file] [--chat-history-file]
             [--restore-chat-history | --no-restore-chat-history]
             [--llm-history-file] [--dark-mode] [--light-mode]
             [--pretty | --no-pretty] [--stream | --no-stream]
             [--user-input-color] [--tool-output-color]
             [--tool-error-color] [--tool-warning-color]
             [--assistant-output-color] [--completion-menu-color]
             [--completion-menu-bg-color]
             [--completion-menu-current-color]
             [--completion-menu-current-bg-color] [--code-theme]
             [--show-diffs] [--git | --no-git]
             [--gitignore | --no-gitignore]
             [--add-gitignore-files | --no-add-gitignore-files]
             [--aiderignore] [--subtree-only]
             [--auto-commits | --no-auto-commits]
             [--dirty-commits | --no-dirty-commits]
             [--attribute-author | --no-attribute-author]
             [--attribute-committer | --no-attribute-committer]
             [--attribute-commit-message-author | --no-attribute-commit-message-author]
             [--attribute-commit-message-committer | --no-attribute-commit-message-committer]
             [--attribute-co-authored-by | --no-attribute-co-authored-by]
             [--git-commit-verify | --no-git-commit-verify]
             [--commit] [--commit-prompt] [--dry-run | --no-dry-run]
             [--skip-sanity-check-repo]
             [--watch-files | --no-watch-files] [--lint]
             [--lint-cmd] [--auto-lint | --no-auto-lint]
             [--test-cmd] [--auto-test | --no-auto-test] [--test]
             [--analytics | --no-analytics] [--analytics-log]
             [--analytics-disable] [--analytics-posthog-host]
             [--analytics-posthog-project-api-key]
             [--just-check-update]
             [--check-update | --no-check-update]
             [--show-release-notes | --no-show-release-notes]
             [--install-main-branch] [--upgrade] [--version]
             [--message] [--message-file]
             [--gui | --no-gui | --browser | --no-browser]
             [--copy-paste | --no-copy-paste] [--apply]
             [--apply-clipboard-edits] [--exit] [--show-repo-map]
             [--show-prompts] [--voice-format] [--voice-language]
             [--voice-input-device] [--disable-playwright] [--file]
             [--read] [--vim] [--chat-language] [--commit-language]
             [--yes-always] [-v] [--load] [--encoding]
             [--line-endings] [-c] [--env-file]
             [--suggest-shell-commands | --no-suggest-shell-commands]
             [--fancy-input | --no-fancy-input]
             [--multiline | --no-multiline]
             [--notifications | --no-notifications]
             [--notifications-command]
             [--detect-urls | --no-detect-urls] [--editor]
             [--shell-completions] [--opus] [--sonnet] [--haiku]
             [--4] [--4o] [--mini] [--4-turbo] [--35turbo]
             [--deepseek] [--o1-mini] [--o1-preview]

</code></pre></div></div>
<h2 id="options">
  
  
    <a href="#options" class="anchor-heading" aria-labelledby="options"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> options:
  
  
</h2>
    
<h3 id="--help">
  
  
    <a href="#--help" class="anchor-heading" aria-labelledby="--help"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--help</code>
  
  
</h3>
    
<p>show this help message and exit<br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">-h</code></li>
  <li><code class="language-plaintext highlighter-rouge">--help</code></li>
</ul>
<h2 id="main-model">
  
  
    <a href="#main-model" class="anchor-heading" aria-labelledby="main-model"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Main model:
  
  
</h2>
    
<h3 id="--model-model">
  
  
    <a href="#--model-model" class="anchor-heading" aria-labelledby="--model-model"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--model MODEL</code>
  
  
</h3>
    
<p>Specify the model to use for the main chat<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MODEL</code></p>
<h2 id="api-keys-and-settings">
  
  
    <a href="#api-keys-and-settings" class="anchor-heading" aria-labelledby="api-keys-and-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> API Keys and settings:
  
  
</h2>
    
<h3 id="--openai-api-key-value">
  
  
    <a href="#--openai-api-key-value" class="anchor-heading" aria-labelledby="--openai-api-key-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-api-key VALUE</code>
  
  
</h3>
    
<p>Specify the OpenAI API key<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_OPENAI_API_KEY</code></p>
<h3 id="--anthropic-api-key-value">
  
  
    <a href="#--anthropic-api-key-value" class="anchor-heading" aria-labelledby="--anthropic-api-key-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--anthropic-api-key VALUE</code>
  
  
</h3>
    
<p>Specify the Anthropic API key<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANTHROPIC_API_KEY</code></p>
<h3 id="--openai-api-base-value">
  
  
    <a href="#--openai-api-base-value" class="anchor-heading" aria-labelledby="--openai-api-base-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-api-base VALUE</code>
  
  
</h3>
    
<p>Specify the api base url<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_OPENAI_API_BASE</code></p>
<h3 id="--openai-api-type-value">
  
  
    <a href="#--openai-api-type-value" class="anchor-heading" aria-labelledby="--openai-api-type-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-api-type VALUE</code>
  
  
</h3>
    
<p>(deprecated, use –set-env OPENAI_API_TYPE=<value>)  
Environment variable: `AIDER_OPENAI_API_TYPE`</value></p>
<h3 id="--openai-api-version-value">
  
  
    <a href="#--openai-api-version-value" class="anchor-heading" aria-labelledby="--openai-api-version-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-api-version VALUE</code>
  
  
</h3>
    
<p>(deprecated, use –set-env OPENAI_API_VERSION=<value>)  
Environment variable: `AIDER_OPENAI_API_VERSION`</value></p>
<h3 id="--openai-api-deployment-id-value">
  
  
    <a href="#--openai-api-deployment-id-value" class="anchor-heading" aria-labelledby="--openai-api-deployment-id-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-api-deployment-id VALUE</code>
  
  
</h3>
    
<p>(deprecated, use –set-env OPENAI_API_DEPLOYMENT_ID=<value>)  
Environment variable: `AIDER_OPENAI_API_DEPLOYMENT_ID`</value></p>
<h3 id="--openai-organization-id-value">
  
  
    <a href="#--openai-organization-id-value" class="anchor-heading" aria-labelledby="--openai-organization-id-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--openai-organization-id VALUE</code>
  
  
</h3>
    
<p>(deprecated, use –set-env OPENAI_ORGANIZATION=<value>)  
Environment variable: `AIDER_OPENAI_ORGANIZATION_ID`</value></p>
<h3 id="--set-env-env_var_namevalue">
  
  
    <a href="#--set-env-env_var_namevalue" class="anchor-heading" aria-labelledby="--set-env-env_var_namevalue"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--set-env ENV_VAR_NAME=value</code>
  
  
</h3>
    
<p>Set an environment variable (to control API settings, can be used multiple times)<br />
Default: []<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SET_ENV</code></p>
<h3 id="--api-key-providerkey">
  
  
    <a href="#--api-key-providerkey" class="anchor-heading" aria-labelledby="--api-key-providerkey"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--api-key PROVIDER=KEY</code>
  
  
</h3>
    
<p>Set an API key for a provider (eg: –api-key provider=<key> sets PROVIDER_API_KEY=<key>)  
Default: []  
Environment variable: `AIDER_API_KEY`</key></key></p>
<h2 id="model-settings">
  
  
    <a href="#model-settings" class="anchor-heading" aria-labelledby="model-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Model settings:
  
  
</h2>
    
<h3 id="--list-models-model">
  
  
    <a href="#--list-models-model" class="anchor-heading" aria-labelledby="--list-models-model"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--list-models MODEL</code>
  
  
</h3>
    
<p>List known models which match the (partial) MODEL name<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LIST_MODELS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--list-models MODEL</code></li>
  <li><code class="language-plaintext highlighter-rouge">--models MODEL</code></li>
</ul>
<h3 id="--model-settings-file-model_settings_file">
  
  
    <a href="#--model-settings-file-model_settings_file" class="anchor-heading" aria-labelledby="--model-settings-file-model_settings_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--model-settings-file MODEL_SETTINGS_FILE</code>
  
  
</h3>
    
<p>Specify a file with aider model settings for unknown models<br />
Default: .aider.model.settings.yml<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MODEL_SETTINGS_FILE</code></p>
<h3 id="--model-metadata-file-model_metadata_file">
  
  
    <a href="#--model-metadata-file-model_metadata_file" class="anchor-heading" aria-labelledby="--model-metadata-file-model_metadata_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--model-metadata-file MODEL_METADATA_FILE</code>
  
  
</h3>
    
<p>Specify a file with context window and costs for unknown models<br />
Default: .aider.model.metadata.json<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MODEL_METADATA_FILE</code></p>
<h3 id="--alias-aliasmodel">
  
  
    <a href="#--alias-aliasmodel" class="anchor-heading" aria-labelledby="--alias-aliasmodel"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--alias ALIAS:MODEL</code>
  
  
</h3>
    
<p>Add a model alias (can be used multiple times)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ALIAS</code></p>
<h3 id="--reasoning-effort-value">
  
  
    <a href="#--reasoning-effort-value" class="anchor-heading" aria-labelledby="--reasoning-effort-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--reasoning-effort VALUE</code>
  
  
</h3>
    
<p>Set the reasoning_effort API parameter (default: not set)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_REASONING_EFFORT</code></p>
<h3 id="--thinking-tokens-value">
  
  
    <a href="#--thinking-tokens-value" class="anchor-heading" aria-labelledby="--thinking-tokens-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--thinking-tokens VALUE</code>
  
  
</h3>
    
<p>Set the thinking token budget for models that support it. Use 0 to disable. (default: not set)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_THINKING_TOKENS</code></p>
<h3 id="--verify-ssl">
  
  
    <a href="#--verify-ssl" class="anchor-heading" aria-labelledby="--verify-ssl"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--verify-ssl</code>
  
  
</h3>
    
<p>Verify the SSL cert when connecting to models (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VERIFY_SSL</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--verify-ssl</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-verify-ssl</code></li>
</ul>
<h3 id="--timeout-value">
  
  
    <a href="#--timeout-value" class="anchor-heading" aria-labelledby="--timeout-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--timeout VALUE</code>
  
  
</h3>
    
<p>Timeout in seconds for API calls (default: None)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TIMEOUT</code></p>
<h3 id="--edit-format-edit_format">
  
  
    <a href="#--edit-format-edit_format" class="anchor-heading" aria-labelledby="--edit-format-edit_format"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--edit-format EDIT_FORMAT</code>
  
  
</h3>
    
<p>Specify what edit format the LLM should use (default depends on model)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_EDIT_FORMAT</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--edit-format EDIT_FORMAT</code></li>
  <li><code class="language-plaintext highlighter-rouge">--chat-mode EDIT_FORMAT</code></li>
</ul>
<h3 id="--architect">
  
  
    <a href="#--architect" class="anchor-heading" aria-labelledby="--architect"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--architect</code>
  
  
</h3>
    
<p>Use architect edit format for the main chat<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ARCHITECT</code></p>
<h3 id="--auto-accept-architect">
  
  
    <a href="#--auto-accept-architect" class="anchor-heading" aria-labelledby="--auto-accept-architect"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--auto-accept-architect</code>
  
  
</h3>
    
<p>Enable/disable automatic acceptance of architect changes (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_AUTO_ACCEPT_ARCHITECT</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--auto-accept-architect</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-auto-accept-architect</code></li>
</ul>
<h3 id="--weak-model-weak_model">
  
  
    <a href="#--weak-model-weak_model" class="anchor-heading" aria-labelledby="--weak-model-weak_model"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--weak-model WEAK_MODEL</code>
  
  
</h3>
    
<p>Specify the model to use for commit messages and chat history summarization (default depends on –model)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_WEAK_MODEL</code></p>
<h3 id="--editor-model-editor_model">
  
  
    <a href="#--editor-model-editor_model" class="anchor-heading" aria-labelledby="--editor-model-editor_model"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--editor-model EDITOR_MODEL</code>
  
  
</h3>
    
<p>Specify the model to use for editor tasks (default depends on –model)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_EDITOR_MODEL</code></p>
<h3 id="--editor-edit-format-editor_edit_format">
  
  
    <a href="#--editor-edit-format-editor_edit_format" class="anchor-heading" aria-labelledby="--editor-edit-format-editor_edit_format"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--editor-edit-format EDITOR_EDIT_FORMAT</code>
  
  
</h3>
    
<p>Specify the edit format for the editor model (default: depends on editor model)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_EDITOR_EDIT_FORMAT</code></p>
<h3 id="--show-model-warnings">
  
  
    <a href="#--show-model-warnings" class="anchor-heading" aria-labelledby="--show-model-warnings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--show-model-warnings</code>
  
  
</h3>
    
<p>Only work with models that have meta-data available (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHOW_MODEL_WARNINGS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--show-model-warnings</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-show-model-warnings</code></li>
</ul>
<h3 id="--check-model-accepts-settings">
  
  
    <a href="#--check-model-accepts-settings" class="anchor-heading" aria-labelledby="--check-model-accepts-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--check-model-accepts-settings</code>
  
  
</h3>
    
<p>Check if model accepts settings like reasoning_effort/thinking_tokens (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CHECK_MODEL_ACCEPTS_SETTINGS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--check-model-accepts-settings</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-check-model-accepts-settings</code></li>
</ul>
<h3 id="--max-chat-history-tokens-value">
  
  
    <a href="#--max-chat-history-tokens-value" class="anchor-heading" aria-labelledby="--max-chat-history-tokens-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--max-chat-history-tokens VALUE</code>
  
  
</h3>
    
<p>Soft limit on tokens for chat history, after which summarization begins. If unspecified, defaults to the model’s max_chat_history_tokens.<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MAX_CHAT_HISTORY_TOKENS</code></p>
<h2 id="cache-settings">
  
  
    <a href="#cache-settings" class="anchor-heading" aria-labelledby="cache-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Cache settings:
  
  
</h2>
    
<h3 id="--cache-prompts">
  
  
    <a href="#--cache-prompts" class="anchor-heading" aria-labelledby="--cache-prompts"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--cache-prompts</code>
  
  
</h3>
    
<p>Enable caching of prompts (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CACHE_PROMPTS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--cache-prompts</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-cache-prompts</code></li>
</ul>
<h3 id="--cache-keepalive-pings-value">
  
  
    <a href="#--cache-keepalive-pings-value" class="anchor-heading" aria-labelledby="--cache-keepalive-pings-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--cache-keepalive-pings VALUE</code>
  
  
</h3>
    
<p>Number of times to ping at 5min intervals to keep prompt cache warm (default: 0)<br />
Default: 0<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CACHE_KEEPALIVE_PINGS</code></p>
<h2 id="repomap-settings">
  
  
    <a href="#repomap-settings" class="anchor-heading" aria-labelledby="repomap-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Repomap settings:
  
  
</h2>
    
<h3 id="--map-tokens-value">
  
  
    <a href="#--map-tokens-value" class="anchor-heading" aria-labelledby="--map-tokens-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--map-tokens VALUE</code>
  
  
</h3>
    
<p>Suggested number of tokens to use for repo map, use 0 to disable<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MAP_TOKENS</code></p>
<h3 id="--map-refresh-value">
  
  
    <a href="#--map-refresh-value" class="anchor-heading" aria-labelledby="--map-refresh-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--map-refresh VALUE</code>
  
  
</h3>
    
<p>Control how often the repo map is refreshed. Options: auto, always, files, manual (default: auto)<br />
Default: auto<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MAP_REFRESH</code></p>
<h3 id="--map-multiplier-no-files-value">
  
  
    <a href="#--map-multiplier-no-files-value" class="anchor-heading" aria-labelledby="--map-multiplier-no-files-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--map-multiplier-no-files VALUE</code>
  
  
</h3>
    
<p>Multiplier for map tokens when no files are specified (default: 2)<br />
Default: 2<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MAP_MULTIPLIER_NO_FILES</code></p>
<h2 id="history-files">
  
  
    <a href="#history-files" class="anchor-heading" aria-labelledby="history-files"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> History Files:
  
  
</h2>
    
<h3 id="--input-history-file-input_history_file">
  
  
    <a href="#--input-history-file-input_history_file" class="anchor-heading" aria-labelledby="--input-history-file-input_history_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--input-history-file INPUT_HISTORY_FILE</code>
  
  
</h3>
    
<p>Specify the chat input history file (default: .aider.input.history)<br />
Default: .aider.input.history<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_INPUT_HISTORY_FILE</code></p>
<h3 id="--chat-history-file-chat_history_file">
  
  
    <a href="#--chat-history-file-chat_history_file" class="anchor-heading" aria-labelledby="--chat-history-file-chat_history_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--chat-history-file CHAT_HISTORY_FILE</code>
  
  
</h3>
    
<p>Specify the chat history file (default: .aider.chat.history.md)<br />
Default: .aider.chat.history.md<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CHAT_HISTORY_FILE</code></p>
<h3 id="--restore-chat-history">
  
  
    <a href="#--restore-chat-history" class="anchor-heading" aria-labelledby="--restore-chat-history"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--restore-chat-history</code>
  
  
</h3>
    
<p>Restore the previous chat history messages (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_RESTORE_CHAT_HISTORY</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--restore-chat-history</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-restore-chat-history</code></li>
</ul>
<h3 id="--llm-history-file-llm_history_file">
  
  
    <a href="#--llm-history-file-llm_history_file" class="anchor-heading" aria-labelledby="--llm-history-file-llm_history_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--llm-history-file LLM_HISTORY_FILE</code>
  
  
</h3>
    
<p>Log the conversation with the LLM to this file (for example, .aider.llm.history)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LLM_HISTORY_FILE</code></p>
<h2 id="output-settings">
  
  
    <a href="#output-settings" class="anchor-heading" aria-labelledby="output-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Output settings:
  
  
</h2>
    
<h3 id="--dark-mode">
  
  
    <a href="#--dark-mode" class="anchor-heading" aria-labelledby="--dark-mode"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--dark-mode</code>
  
  
</h3>
    
<p>Use colors suitable for a dark terminal background (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DARK_MODE</code></p>
<h3 id="--light-mode">
  
  
    <a href="#--light-mode" class="anchor-heading" aria-labelledby="--light-mode"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--light-mode</code>
  
  
</h3>
    
<p>Use colors suitable for a light terminal background (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LIGHT_MODE</code></p>
<h3 id="--pretty">
  
  
    <a href="#--pretty" class="anchor-heading" aria-labelledby="--pretty"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--pretty</code>
  
  
</h3>
    
<p>Enable/disable pretty, colorized output (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_PRETTY</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--pretty</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-pretty</code></li>
</ul>
<h3 id="--stream">
  
  
    <a href="#--stream" class="anchor-heading" aria-labelledby="--stream"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--stream</code>
  
  
</h3>
    
<p>Enable/disable streaming responses (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_STREAM</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--stream</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-stream</code></li>
</ul>
<h3 id="--user-input-color-value">
  
  
    <a href="#--user-input-color-value" class="anchor-heading" aria-labelledby="--user-input-color-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--user-input-color VALUE</code>
  
  
</h3>
    
<p>Set the color for user input (default: #00cc00)<br />
Default: #00cc00<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_USER_INPUT_COLOR</code></p>
<h3 id="--tool-output-color-value">
  
  
    <a href="#--tool-output-color-value" class="anchor-heading" aria-labelledby="--tool-output-color-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--tool-output-color VALUE</code>
  
  
</h3>
    
<p>Set the color for tool output (default: None)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TOOL_OUTPUT_COLOR</code></p>
<h3 id="--tool-error-color-value">
  
  
    <a href="#--tool-error-color-value" class="anchor-heading" aria-labelledby="--tool-error-color-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--tool-error-color VALUE</code>
  
  
</h3>
    
<p>Set the color for tool error messages (default: #FF2222)<br />
Default: #FF2222<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TOOL_ERROR_COLOR</code></p>
<h3 id="--tool-warning-color-value">
  
  
    <a href="#--tool-warning-color-value" class="anchor-heading" aria-labelledby="--tool-warning-color-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--tool-warning-color VALUE</code>
  
  
</h3>
    
<p>Set the color for tool warning messages (default: #FFA500)<br />
Default: #FFA500<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TOOL_WARNING_COLOR</code></p>
<h3 id="--assistant-output-color-value">
  
  
    <a href="#--assistant-output-color-value" class="anchor-heading" aria-labelledby="--assistant-output-color-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--assistant-output-color VALUE</code>
  
  
</h3>
    
<p>Set the color for assistant output (default: #0088ff)<br />
Default: #0088ff<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ASSISTANT_OUTPUT_COLOR</code></p>
<h3 id="--completion-menu-color-color">
  
  
    <a href="#--completion-menu-color-color" class="anchor-heading" aria-labelledby="--completion-menu-color-color"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--completion-menu-color COLOR</code>
  
  
</h3>
    
<p>Set the color for the completion menu (default: terminal’s default text color)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMPLETION_MENU_COLOR</code></p>
<h3 id="--completion-menu-bg-color-color">
  
  
    <a href="#--completion-menu-bg-color-color" class="anchor-heading" aria-labelledby="--completion-menu-bg-color-color"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--completion-menu-bg-color COLOR</code>
  
  
</h3>
    
<p>Set the background color for the completion menu (default: terminal’s default background color)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMPLETION_MENU_BG_COLOR</code></p>
<h3 id="--completion-menu-current-color-color">
  
  
    <a href="#--completion-menu-current-color-color" class="anchor-heading" aria-labelledby="--completion-menu-current-color-color"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--completion-menu-current-color COLOR</code>
  
  
</h3>
    
<p>Set the color for the current item in the completion menu (default: terminal’s default background color)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMPLETION_MENU_CURRENT_COLOR</code></p>
<h3 id="--completion-menu-current-bg-color-color">
  
  
    <a href="#--completion-menu-current-bg-color-color" class="anchor-heading" aria-labelledby="--completion-menu-current-bg-color-color"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--completion-menu-current-bg-color COLOR</code>
  
  
</h3>
    
<p>Set the background color for the current item in the completion menu (default: terminal’s default text color)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMPLETION_MENU_CURRENT_BG_COLOR</code></p>
<h3 id="--code-theme-value">
  
  
    <a href="#--code-theme-value" class="anchor-heading" aria-labelledby="--code-theme-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--code-theme VALUE</code>
  
  
</h3>
    
<p>Set the markdown code theme (default: default, other options include monokai, solarized-dark, solarized-light, or a Pygments builtin style, see https://pygments.org/styles for available themes)<br />
Default: default<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CODE_THEME</code></p>
<h3 id="--show-diffs">
  
  
    <a href="#--show-diffs" class="anchor-heading" aria-labelledby="--show-diffs"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--show-diffs</code>
  
  
</h3>
    
<p>Show diffs when committing changes (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHOW_DIFFS</code></p>
<h2 id="git-settings">
  
  
    <a href="#git-settings" class="anchor-heading" aria-labelledby="git-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Git settings:
  
  
</h2>
    
<h3 id="--git">
  
  
    <a href="#--git" class="anchor-heading" aria-labelledby="--git"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--git</code>
  
  
</h3>
    
<p>Enable/disable looking for a git repo (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_GIT</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--git</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-git</code></li>
</ul>
<h3 id="--gitignore">
  
  
    <a href="#--gitignore" class="anchor-heading" aria-labelledby="--gitignore"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--gitignore</code>
  
  
</h3>
    
<p>Enable/disable adding .aider* to .gitignore (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_GITIGNORE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--gitignore</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-gitignore</code></li>
</ul>
<h3 id="--add-gitignore-files">
  
  
    <a href="#--add-gitignore-files" class="anchor-heading" aria-labelledby="--add-gitignore-files"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--add-gitignore-files</code>
  
  
</h3>
    
<p>Enable/disable the addition of files listed in .gitignore to Aider’s editing scope.<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ADD_GITIGNORE_FILES</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--add-gitignore-files</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-add-gitignore-files</code></li>
</ul>
<h3 id="--aiderignore-aiderignore">
  
  
    <a href="#--aiderignore-aiderignore" class="anchor-heading" aria-labelledby="--aiderignore-aiderignore"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--aiderignore AIDERIGNORE</code>
  
  
</h3>
    
<p>Specify the aider ignore file (default: .aiderignore in git root)<br />
Default: .aiderignore<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_AIDERIGNORE</code></p>
<h3 id="--subtree-only">
  
  
    <a href="#--subtree-only" class="anchor-heading" aria-labelledby="--subtree-only"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--subtree-only</code>
  
  
</h3>
    
<p>Only consider files in the current subtree of the git repository<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SUBTREE_ONLY</code></p>
<h3 id="--auto-commits">
  
  
    <a href="#--auto-commits" class="anchor-heading" aria-labelledby="--auto-commits"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--auto-commits</code>
  
  
</h3>
    
<p>Enable/disable auto commit of LLM changes (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_AUTO_COMMITS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--auto-commits</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-auto-commits</code></li>
</ul>
<h3 id="--dirty-commits">
  
  
    <a href="#--dirty-commits" class="anchor-heading" aria-labelledby="--dirty-commits"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--dirty-commits</code>
  
  
</h3>
    
<p>Enable/disable commits when repo is found dirty (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DIRTY_COMMITS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--dirty-commits</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-dirty-commits</code></li>
</ul>
<h3 id="--attribute-author">
  
  
    <a href="#--attribute-author" class="anchor-heading" aria-labelledby="--attribute-author"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--attribute-author</code>
  
  
</h3>
    
<p>Attribute aider code changes in the git author name (default: True). If explicitly set to True, overrides –attribute-co-authored-by precedence.<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ATTRIBUTE_AUTHOR</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--attribute-author</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-attribute-author</code></li>
</ul>
<h3 id="--attribute-committer">
  
  
    <a href="#--attribute-committer" class="anchor-heading" aria-labelledby="--attribute-committer"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--attribute-committer</code>
  
  
</h3>
    
<p>Attribute aider commits in the git committer name (default: True). If explicitly set to True, overrides –attribute-co-authored-by precedence for aider edits.<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ATTRIBUTE_COMMITTER</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--attribute-committer</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-attribute-committer</code></li>
</ul>
<h3 id="--attribute-commit-message-author">
  
  
    <a href="#--attribute-commit-message-author" class="anchor-heading" aria-labelledby="--attribute-commit-message-author"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--attribute-commit-message-author</code>
  
  
</h3>
    
<p>Prefix commit messages with ‘aider: ‘ if aider authored the changes (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ATTRIBUTE_COMMIT_MESSAGE_AUTHOR</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--attribute-commit-message-author</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-attribute-commit-message-author</code></li>
</ul>
<h3 id="--attribute-commit-message-committer">
  
  
    <a href="#--attribute-commit-message-committer" class="anchor-heading" aria-labelledby="--attribute-commit-message-committer"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--attribute-commit-message-committer</code>
  
  
</h3>
    
<p>Prefix all commit messages with ‘aider: ‘ (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ATTRIBUTE_COMMIT_MESSAGE_COMMITTER</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--attribute-commit-message-committer</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-attribute-commit-message-committer</code></li>
</ul>
<h3 id="--attribute-co-authored-by">
  
  
    <a href="#--attribute-co-authored-by" class="anchor-heading" aria-labelledby="--attribute-co-authored-by"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--attribute-co-authored-by</code>
  
  
</h3>
    
<p>Attribute aider edits using the Co-authored-by trailer in the commit message (default: True). If True, this takes precedence over default –attribute-author and –attribute-committer behavior unless they are explicitly set to True.<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ATTRIBUTE_CO_AUTHORED_BY</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--attribute-co-authored-by</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-attribute-co-authored-by</code></li>
</ul>
<h3 id="--git-commit-verify">
  
  
    <a href="#--git-commit-verify" class="anchor-heading" aria-labelledby="--git-commit-verify"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--git-commit-verify</code>
  
  
</h3>
    
<p>Enable/disable git pre-commit hooks with –no-verify (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_GIT_COMMIT_VERIFY</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--git-commit-verify</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-git-commit-verify</code></li>
</ul>
<h3 id="--commit">
  
  
    <a href="#--commit" class="anchor-heading" aria-labelledby="--commit"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--commit</code>
  
  
</h3>
    
<p>Commit all pending changes with a suitable commit message, then exit<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMMIT</code></p>
<h3 id="--commit-prompt-prompt">
  
  
    <a href="#--commit-prompt-prompt" class="anchor-heading" aria-labelledby="--commit-prompt-prompt"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--commit-prompt PROMPT</code>
  
  
</h3>
    
<p>Specify a custom prompt for generating commit messages<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMMIT_PROMPT</code></p>
<h3 id="--dry-run">
  
  
    <a href="#--dry-run" class="anchor-heading" aria-labelledby="--dry-run"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--dry-run</code>
  
  
</h3>
    
<p>Perform a dry run without modifying files (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DRY_RUN</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--dry-run</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-dry-run</code></li>
</ul>
<h3 id="--skip-sanity-check-repo">
  
  
    <a href="#--skip-sanity-check-repo" class="anchor-heading" aria-labelledby="--skip-sanity-check-repo"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--skip-sanity-check-repo</code>
  
  
</h3>
    
<p>Skip the sanity check for the git repository (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SKIP_SANITY_CHECK_REPO</code></p>
<h3 id="--watch-files">
  
  
    <a href="#--watch-files" class="anchor-heading" aria-labelledby="--watch-files"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--watch-files</code>
  
  
</h3>
    
<p>Enable/disable watching files for ai coding comments (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_WATCH_FILES</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--watch-files</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-watch-files</code></li>
</ul>
<h2 id="fixing-and-committing">
  
  
    <a href="#fixing-and-committing" class="anchor-heading" aria-labelledby="fixing-and-committing"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Fixing and committing:
  
  
</h2>
    
<h3 id="--lint">
  
  
    <a href="#--lint" class="anchor-heading" aria-labelledby="--lint"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--lint</code>
  
  
</h3>
    
<p>Lint and fix provided files, or dirty files if none provided<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LINT</code></p>
<h3 id="--lint-cmd">
  
  
    <a href="#--lint-cmd" class="anchor-heading" aria-labelledby="--lint-cmd"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--lint-cmd</code>
  
  
</h3>
    
<p>Specify lint commands to run for different languages, eg: “python: flake8 –select=…” (can be used multiple times)<br />
Default: []<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LINT_CMD</code></p>
<h3 id="--auto-lint">
  
  
    <a href="#--auto-lint" class="anchor-heading" aria-labelledby="--auto-lint"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--auto-lint</code>
  
  
</h3>
    
<p>Enable/disable automatic linting after changes (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_AUTO_LINT</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--auto-lint</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-auto-lint</code></li>
</ul>
<h3 id="--test-cmd-value">
  
  
    <a href="#--test-cmd-value" class="anchor-heading" aria-labelledby="--test-cmd-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--test-cmd VALUE</code>
  
  
</h3>
    
<p>Specify command to run tests<br />
Default: []<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TEST_CMD</code></p>
<h3 id="--auto-test">
  
  
    <a href="#--auto-test" class="anchor-heading" aria-labelledby="--auto-test"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--auto-test</code>
  
  
</h3>
    
<p>Enable/disable automatic testing after changes (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_AUTO_TEST</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--auto-test</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-auto-test</code></li>
</ul>
<h3 id="--test">
  
  
    <a href="#--test" class="anchor-heading" aria-labelledby="--test"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--test</code>
  
  
</h3>
    
<p>Run tests, fix problems found and then exit<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_TEST</code></p>
<h2 id="analytics">
  
  
    <a href="#analytics" class="anchor-heading" aria-labelledby="analytics"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Analytics:
  
  
</h2>
    
<h3 id="--analytics">
  
  
    <a href="#--analytics" class="anchor-heading" aria-labelledby="--analytics"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--analytics</code>
  
  
</h3>
    
<p>Enable/disable analytics for current session (default: random)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANALYTICS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--analytics</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-analytics</code></li>
</ul>
<h3 id="--analytics-log-analytics_log_file">
  
  
    <a href="#--analytics-log-analytics_log_file" class="anchor-heading" aria-labelledby="--analytics-log-analytics_log_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--analytics-log ANALYTICS_LOG_FILE</code>
  
  
</h3>
    
<p>Specify a file to log analytics events<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANALYTICS_LOG</code></p>
<h3 id="--analytics-disable">
  
  
    <a href="#--analytics-disable" class="anchor-heading" aria-labelledby="--analytics-disable"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--analytics-disable</code>
  
  
</h3>
    
<p>Permanently disable analytics<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANALYTICS_DISABLE</code></p>
<h3 id="--analytics-posthog-host-analytics_posthog_host">
  
  
    <a href="#--analytics-posthog-host-analytics_posthog_host" class="anchor-heading" aria-labelledby="--analytics-posthog-host-analytics_posthog_host"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--analytics-posthog-host ANALYTICS_POSTHOG_HOST</code>
  
  
</h3>
    
<p>Send analytics to custom PostHog instance<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANALYTICS_POSTHOG_HOST</code></p>
<h3 id="--analytics-posthog-project-api-key-analytics_posthog_project_api_key">
  
  
    <a href="#--analytics-posthog-project-api-key-analytics_posthog_project_api_key" class="anchor-heading" aria-labelledby="--analytics-posthog-project-api-key-analytics_posthog_project_api_key"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--analytics-posthog-project-api-key ANALYTICS_POSTHOG_PROJECT_API_KEY</code>
  
  
</h3>
    
<p>Send analytics to custom PostHog project<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ANALYTICS_POSTHOG_PROJECT_API_KEY</code></p>
<h2 id="upgrading">
  
  
    <a href="#upgrading" class="anchor-heading" aria-labelledby="upgrading"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Upgrading:
  
  
</h2>
    
<h3 id="--just-check-update">
  
  
    <a href="#--just-check-update" class="anchor-heading" aria-labelledby="--just-check-update"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--just-check-update</code>
  
  
</h3>
    
<p>Check for updates and return status in the exit code<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_JUST_CHECK_UPDATE</code></p>
<h3 id="--check-update">
  
  
    <a href="#--check-update" class="anchor-heading" aria-labelledby="--check-update"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--check-update</code>
  
  
</h3>
    
<p>Check for new aider versions on launch<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CHECK_UPDATE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--check-update</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-check-update</code></li>
</ul>
<h3 id="--show-release-notes">
  
  
    <a href="#--show-release-notes" class="anchor-heading" aria-labelledby="--show-release-notes"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--show-release-notes</code>
  
  
</h3>
    
<p>Show release notes on first run of new version (default: None, ask user)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHOW_RELEASE_NOTES</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--show-release-notes</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-show-release-notes</code></li>
</ul>
<h3 id="--install-main-branch">
  
  
    <a href="#--install-main-branch" class="anchor-heading" aria-labelledby="--install-main-branch"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--install-main-branch</code>
  
  
</h3>
    
<p>Install the latest version from the main branch<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_INSTALL_MAIN_BRANCH</code></p>
<h3 id="--upgrade">
  
  
    <a href="#--upgrade" class="anchor-heading" aria-labelledby="--upgrade"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--upgrade</code>
  
  
</h3>
    
<p>Upgrade aider to the latest version from PyPI<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_UPGRADE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--upgrade</code></li>
  <li><code class="language-plaintext highlighter-rouge">--update</code></li>
</ul>
<h3 id="--version">
  
  
    <a href="#--version" class="anchor-heading" aria-labelledby="--version"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--version</code>
  
  
</h3>
    
<p>Show the version number and exit</p>
<h2 id="modes">
  
  
    <a href="#modes" class="anchor-heading" aria-labelledby="modes"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Modes:
  
  
</h2>
    
<h3 id="--message-command">
  
  
    <a href="#--message-command" class="anchor-heading" aria-labelledby="--message-command"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--message COMMAND</code>
  
  
</h3>
    
<p>Specify a single message to send the LLM, process reply then exit (disables chat mode)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MESSAGE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--message COMMAND</code></li>
  <li><code class="language-plaintext highlighter-rouge">--msg COMMAND</code></li>
  <li><code class="language-plaintext highlighter-rouge">-m COMMAND</code></li>
</ul>
<h3 id="--message-file-message_file">
  
  
    <a href="#--message-file-message_file" class="anchor-heading" aria-labelledby="--message-file-message_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--message-file MESSAGE_FILE</code>
  
  
</h3>
    
<p>Specify a file containing the message to send the LLM, process reply, then exit (disables chat mode)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MESSAGE_FILE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--message-file MESSAGE_FILE</code></li>
  <li><code class="language-plaintext highlighter-rouge">-f MESSAGE_FILE</code></li>
</ul>
<h3 id="--gui">
  
  
    <a href="#--gui" class="anchor-heading" aria-labelledby="--gui"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--gui</code>
  
  
</h3>
    
<p>Run aider in your browser (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_GUI</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--gui</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-gui</code></li>
  <li><code class="language-plaintext highlighter-rouge">--browser</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-browser</code></li>
</ul>
<h3 id="--copy-paste">
  
  
    <a href="#--copy-paste" class="anchor-heading" aria-labelledby="--copy-paste"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--copy-paste</code>
  
  
</h3>
    
<p>Enable automatic copy/paste of chat between aider and web UI (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COPY_PASTE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--copy-paste</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-copy-paste</code></li>
</ul>
<h3 id="--apply-file">
  
  
    <a href="#--apply-file" class="anchor-heading" aria-labelledby="--apply-file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--apply FILE</code>
  
  
</h3>
    
<p>Apply the changes from the given file instead of running the chat (debug)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_APPLY</code></p>
<h3 id="--apply-clipboard-edits">
  
  
    <a href="#--apply-clipboard-edits" class="anchor-heading" aria-labelledby="--apply-clipboard-edits"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--apply-clipboard-edits</code>
  
  
</h3>
    
<p>Apply clipboard contents as edits using the main model’s editor format<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_APPLY_CLIPBOARD_EDITS</code></p>
<h3 id="--exit">
  
  
    <a href="#--exit" class="anchor-heading" aria-labelledby="--exit"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--exit</code>
  
  
</h3>
    
<p>Do all startup activities then exit before accepting user input (debug)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_EXIT</code></p>
<h3 id="--show-repo-map">
  
  
    <a href="#--show-repo-map" class="anchor-heading" aria-labelledby="--show-repo-map"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--show-repo-map</code>
  
  
</h3>
    
<p>Print the repo map and exit (debug)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHOW_REPO_MAP</code></p>
<h3 id="--show-prompts">
  
  
    <a href="#--show-prompts" class="anchor-heading" aria-labelledby="--show-prompts"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--show-prompts</code>
  
  
</h3>
    
<p>Print the system prompts and exit (debug)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHOW_PROMPTS</code></p>
<h2 id="voice-settings">
  
  
    <a href="#voice-settings" class="anchor-heading" aria-labelledby="voice-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Voice settings:
  
  
</h2>
    
<h3 id="--voice-format-voice_format">
  
  
    <a href="#--voice-format-voice_format" class="anchor-heading" aria-labelledby="--voice-format-voice_format"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--voice-format VOICE_FORMAT</code>
  
  
</h3>
    
<p>Audio format for voice recording (default: wav). webm and mp3 require ffmpeg<br />
Default: wav<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VOICE_FORMAT</code></p>
<h3 id="--voice-language-voice_language">
  
  
    <a href="#--voice-language-voice_language" class="anchor-heading" aria-labelledby="--voice-language-voice_language"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--voice-language VOICE_LANGUAGE</code>
  
  
</h3>
    
<p>Specify the language for voice using ISO 639-1 code (default: auto)<br />
Default: en<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VOICE_LANGUAGE</code></p>
<h3 id="--voice-input-device-voice_input_device">
  
  
    <a href="#--voice-input-device-voice_input_device" class="anchor-heading" aria-labelledby="--voice-input-device-voice_input_device"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--voice-input-device VOICE_INPUT_DEVICE</code>
  
  
</h3>
    
<p>Specify the input device name for voice recording<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VOICE_INPUT_DEVICE</code></p>
<h2 id="other-settings">
  
  
    <a href="#other-settings" class="anchor-heading" aria-labelledby="other-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Other settings:
  
  
</h2>
    
<h3 id="--disable-playwright">
  
  
    <a href="#--disable-playwright" class="anchor-heading" aria-labelledby="--disable-playwright"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--disable-playwright</code>
  
  
</h3>
    
<p>Never prompt for or attempt to install Playwright for web scraping (default: False).<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DISABLE_PLAYWRIGHT</code></p>
<h3 id="--file-file">
  
  
    <a href="#--file-file" class="anchor-heading" aria-labelledby="--file-file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--file FILE</code>
  
  
</h3>
    
<p>specify a file to edit (can be used multiple times)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_FILE</code></p>
<h3 id="--read-file">
  
  
    <a href="#--read-file" class="anchor-heading" aria-labelledby="--read-file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--read FILE</code>
  
  
</h3>
    
<p>specify a read-only file (can be used multiple times)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_READ</code></p>
<h3 id="--vim">
  
  
    <a href="#--vim" class="anchor-heading" aria-labelledby="--vim"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--vim</code>
  
  
</h3>
    
<p>Use VI editing mode in the terminal (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VIM</code></p>
<h3 id="--chat-language-chat_language">
  
  
    <a href="#--chat-language-chat_language" class="anchor-heading" aria-labelledby="--chat-language-chat_language"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--chat-language CHAT_LANGUAGE</code>
  
  
</h3>
    
<p>Specify the language to use in the chat (default: None, uses system settings)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_CHAT_LANGUAGE</code></p>
<h3 id="--commit-language-commit_language">
  
  
    <a href="#--commit-language-commit_language" class="anchor-heading" aria-labelledby="--commit-language-commit_language"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--commit-language COMMIT_LANGUAGE</code>
  
  
</h3>
    
<p>Specify the language to use in the commit message (default: None, user language)<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_COMMIT_LANGUAGE</code></p>
<h3 id="--yes-always">
  
  
    <a href="#--yes-always" class="anchor-heading" aria-labelledby="--yes-always"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--yes-always</code>
  
  
</h3>
    
<p>Always say yes to every confirmation<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_YES_ALWAYS</code></p>
<h3 id="--verbose">
  
  
    <a href="#--verbose" class="anchor-heading" aria-labelledby="--verbose"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--verbose</code>
  
  
</h3>
    
<p>Enable verbose output<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_VERBOSE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">-v</code></li>
  <li><code class="language-plaintext highlighter-rouge">--verbose</code></li>
</ul>
<h3 id="--load-load_file">
  
  
    <a href="#--load-load_file" class="anchor-heading" aria-labelledby="--load-load_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--load LOAD_FILE</code>
  
  
</h3>
    
<p>Load and execute /commands from a file on launch<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LOAD</code></p>
<h3 id="--encoding-value">
  
  
    <a href="#--encoding-value" class="anchor-heading" aria-labelledby="--encoding-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--encoding VALUE</code>
  
  
</h3>
    
<p>Specify the encoding for input and output (default: utf-8)<br />
Default: utf-8<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ENCODING</code></p>
<h3 id="--line-endings-value">
  
  
    <a href="#--line-endings-value" class="anchor-heading" aria-labelledby="--line-endings-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--line-endings VALUE</code>
  
  
</h3>
    
<p>Line endings to use when writing files (default: platform)<br />
Default: platform<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_LINE_ENDINGS</code></p>
<h3 id="--config-config_file">
  
  
    <a href="#--config-config_file" class="anchor-heading" aria-labelledby="--config-config_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--config CONFIG_FILE</code>
  
  
</h3>
    
<p>Specify the config file (default: search for .aider.conf.yml in git root, cwd or home directory)<br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">-c CONFIG_FILE</code></li>
  <li><code class="language-plaintext highlighter-rouge">--config CONFIG_FILE</code></li>
</ul>
<h3 id="--env-file-env_file">
  
  
    <a href="#--env-file-env_file" class="anchor-heading" aria-labelledby="--env-file-env_file"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--env-file ENV_FILE</code>
  
  
</h3>
    
<p>Specify the .env file to load (default: .env in git root)<br />
Default: .env<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_ENV_FILE</code></p>
<h3 id="--suggest-shell-commands">
  
  
    <a href="#--suggest-shell-commands" class="anchor-heading" aria-labelledby="--suggest-shell-commands"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--suggest-shell-commands</code>
  
  
</h3>
    
<p>Enable/disable suggesting shell commands (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SUGGEST_SHELL_COMMANDS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--suggest-shell-commands</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-suggest-shell-commands</code></li>
</ul>
<h3 id="--fancy-input">
  
  
    <a href="#--fancy-input" class="anchor-heading" aria-labelledby="--fancy-input"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--fancy-input</code>
  
  
</h3>
    
<p>Enable/disable fancy input with history and completion (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_FANCY_INPUT</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--fancy-input</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-fancy-input</code></li>
</ul>
<h3 id="--multiline">
  
  
    <a href="#--multiline" class="anchor-heading" aria-labelledby="--multiline"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--multiline</code>
  
  
</h3>
    
<p>Enable/disable multi-line input mode with Meta-Enter to submit (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MULTILINE</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--multiline</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-multiline</code></li>
</ul>
<h3 id="--notifications">
  
  
    <a href="#--notifications" class="anchor-heading" aria-labelledby="--notifications"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--notifications</code>
  
  
</h3>
    
<p>Enable/disable terminal bell notifications when LLM responses are ready (default: False)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_NOTIFICATIONS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--notifications</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-notifications</code></li>
</ul>
<h3 id="--notifications-command-command">
  
  
    <a href="#--notifications-command-command" class="anchor-heading" aria-labelledby="--notifications-command-command"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--notifications-command COMMAND</code>
  
  
</h3>
    
<p>Specify a command to run for notifications instead of the terminal bell. If not specified, a default command for your OS may be used.<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_NOTIFICATIONS_COMMAND</code></p>
<h3 id="--detect-urls">
  
  
    <a href="#--detect-urls" class="anchor-heading" aria-labelledby="--detect-urls"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--detect-urls</code>
  
  
</h3>
    
<p>Enable/disable detection and offering to add URLs to chat (default: True)<br />
Default: True<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DETECT_URLS</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--detect-urls</code></li>
  <li><code class="language-plaintext highlighter-rouge">--no-detect-urls</code></li>
</ul>
<h3 id="--editor-value">
  
  
    <a href="#--editor-value" class="anchor-heading" aria-labelledby="--editor-value"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--editor VALUE</code>
  
  
</h3>
    
<p>Specify which editor to use for the /editor command<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_EDITOR</code></p>
<h3 id="--shell-completions-shell">
  
  
    <a href="#--shell-completions-shell" class="anchor-heading" aria-labelledby="--shell-completions-shell"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--shell-completions SHELL</code>
  
  
</h3>
    
<p>Print shell completion script for the specified SHELL and exit. Supported shells: bash, tcsh, zsh. Example: aider –shell-completions bash<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SHELL_COMPLETIONS</code></p>
<h2 id="deprecated-model-settings">
  
  
    <a href="#deprecated-model-settings" class="anchor-heading" aria-labelledby="deprecated-model-settings"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> Deprecated model settings:
  
  
</h2>
    
<h3 id="--opus">
  
  
    <a href="#--opus" class="anchor-heading" aria-labelledby="--opus"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--opus</code>
  
  
</h3>
    
<p>Use claude-3-opus-20240229 model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_OPUS</code></p>
<h3 id="--sonnet">
  
  
    <a href="#--sonnet" class="anchor-heading" aria-labelledby="--sonnet"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--sonnet</code>
  
  
</h3>
    
<p>Use anthropic/claude-3-7-sonnet-20250219 model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_SONNET</code></p>
<h3 id="--haiku">
  
  
    <a href="#--haiku" class="anchor-heading" aria-labelledby="--haiku"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--haiku</code>
  
  
</h3>
    
<p>Use claude-3-5-haiku-20241022 model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_HAIKU</code></p>
<h3 id="--4">
  
  
    <a href="#--4" class="anchor-heading" aria-labelledby="--4"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--4</code>
  
  
</h3>
    
<p>Use gpt-4-0613 model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_4</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--4</code></li>
  <li><code class="language-plaintext highlighter-rouge">-4</code></li>
</ul>
<h3 id="--4o">
  
  
    <a href="#--4o" class="anchor-heading" aria-labelledby="--4o"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--4o</code>
  
  
</h3>
    
<p>Use gpt-4o model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_4O</code></p>
<h3 id="--mini">
  
  
    <a href="#--mini" class="anchor-heading" aria-labelledby="--mini"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--mini</code>
  
  
</h3>
    
<p>Use gpt-4o-mini model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_MINI</code></p>
<h3 id="--4-turbo">
  
  
    <a href="#--4-turbo" class="anchor-heading" aria-labelledby="--4-turbo"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--4-turbo</code>
  
  
</h3>
    
<p>Use gpt-4-1106-preview model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_4_TURBO</code></p>
<h3 id="--35turbo">
  
  
    <a href="#--35turbo" class="anchor-heading" aria-labelledby="--35turbo"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--35turbo</code>
  
  
</h3>
    
<p>Use gpt-3.5-turbo model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_35TURBO</code><br />
Aliases:</p>
<ul>
  <li><code class="language-plaintext highlighter-rouge">--35turbo</code></li>
  <li><code class="language-plaintext highlighter-rouge">--35-turbo</code></li>
  <li><code class="language-plaintext highlighter-rouge">--3</code></li>
  <li><code class="language-plaintext highlighter-rouge">-3</code></li>
</ul>
<h3 id="--deepseek">
  
  
    <a href="#--deepseek" class="anchor-heading" aria-labelledby="--deepseek"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--deepseek</code>
  
  
</h3>
    
<p>Use deepseek/deepseek-chat model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_DEEPSEEK</code></p>
<h3 id="--o1-mini">
  
  
    <a href="#--o1-mini" class="anchor-heading" aria-labelledby="--o1-mini"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--o1-mini</code>
  
  
</h3>
    
<p>Use o1-mini model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_O1_MINI</code></p>
<h3 id="--o1-preview">
  
  
    <a href="#--o1-preview" class="anchor-heading" aria-labelledby="--o1-preview"><svg viewBox="0 0 16 16" aria-hidden="true"><use xlink:href="#svg-link"></use></svg></a> <code class="language-plaintext highlighter-rouge">--o1-preview</code>
  
  
</h3>
    
<p>Use o1-preview model for the main chat (deprecated, use –model)<br />
Default: False<br />
Environment variable: <code class="language-plaintext highlighter-rouge">AIDER_O1_PREVIEW</code><br />
<!--[[[end]]]--></p>

          

          
        </main>
        


      </div>
    </div>
    
      

<div class="search-overlay"></div>

    
  </div>

  
</body>
</html>

