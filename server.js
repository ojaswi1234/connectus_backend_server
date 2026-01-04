import { createServer } from "http";
import { createSchema, createYoga, createPubSub } from "graphql-yoga";
import { WebSocketServer } from 'ws'; //
import { useServer } from 'graphql-ws/use/ws'; //

const pubSub = createPubSub();
const messages = [];

const yoga = createYoga({
  schema: createSchema({
    typeDefs: /* GraphQL */ `
      type Message { id: ID!, user: String!, content: String! }
      type Query { messages: [Message!] }
      type Mutation { postMessage(user: String!, content: String!): ID! }
      type Subscription { messageAdded: Message! }
    `,
    resolvers: {
      Query: { messages: () => messages },
      Mutation: {
        postMessage: (parent, { user, content }) => {
          const newMessage = { id: String(messages.length), user, content };
          messages.push(newMessage);
          pubSub.publish("MESSAGE_ADDED", { messageAdded: newMessage });
          return newMessage.id;
        }
      },
      Subscription: {
        messageAdded: { subscribe: () => pubSub.subscribe("MESSAGE_ADDED") }
      }
    }
  })
});

const server = createServer(yoga);

// Add WebSocket support on the same path as GraphQL
const wsServer = new WebSocketServer({
  server,
  path: yoga.graphqlEndpoint
});

useServer({
  execute: (args) => args.rootValue.execute(args),
  subscribe: (args) => args.rootValue.subscribe(args),
  onSubscribe: async (ctx, msg) => {
    const { schema, execute, subscribe, contextFactory, parse, validate } = yoga.getEnveloped({
      ctx, req: ctx.extra.request, socket: ctx.extra.socket, params: msg.payload
    });
    return { schema, execute, subscribe, contextValue: await contextFactory(), ...msg.payload };
  }
}, wsServer);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Server is running ....');
});