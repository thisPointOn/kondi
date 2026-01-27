import express from 'express';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

app.post('/initialize', (_req, res) => {
  res.json({
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'test-server', version: '1.0.0' },
  });
});

app.post('/tools/list', (_req, res) => {
  res.json({
    tools: [
      {
        name: 'get_weather',
        description: 'Get current weather for a city',
        inputSchema: {
          type: 'object',
          properties: {
            city: { type: 'string', description: 'City name' },
          },
          required: ['city'],
        },
      },
      {
        name: 'calculate',
        description: 'Perform a calculation',
        inputSchema: {
          type: 'object',
          properties: {
            expression: { type: 'string', description: 'Math expression' },
          },
          required: ['expression'],
        },
      },
    ],
  });
});

app.post('/tools/call', (req, res) => {
  const { name, arguments: args } = req.body;

  if (name === 'get_weather') {
    res.json({
      content: [
        {
          type: 'text',
          text: `The weather in ${args.city} is sunny and 72°F.`,
        },
      ],
    });
  } else if (name === 'calculate') {
    try {
      // eval is only used here for demo math; do not reuse in production
      // eslint-disable-next-line no-eval
      const result = eval(args.expression);
      res.json({
        content: [
          {
            type: 'text',
            text: `Result: ${result}`,
          },
        ],
      });
    } catch (_error) {
      res.status(400).json({ error: { message: 'Invalid expression' } });
    }
  } else {
    res.status(404).json({ error: { message: 'Tool not found' } });
  }
});

app.listen(3000, () => {
  console.log('Test MCP server running on http://localhost:3000');
});
