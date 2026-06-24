export default async function handler(req, res) {

  const { appId } = req.query;

  const afRes = await fetch(`https://api2.appsflyer.com/inappevent/${appId}`, {

    method: 'POST',

    headers: {

      'authentication': req.headers['authentication'],

      'Content-Type': 'application/json'

    },

    body: JSON.stringify(req.body)

  });

  const text = await afRes.text();

  res.status(afRes.status).send(text);

}
