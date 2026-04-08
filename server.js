const credentials = {
  type: 'service_account',
  project_id: process.env.GCP_PROJECT_ID || '',
  private_key: Buffer.from(process.env.GCP_PRIVATE_KEY_B64, 'base64').toString('utf8'),
  client_email: process.env.GCP_CLIENT_EMAIL || '',
  client_id: process.env.GCP_CLIENT_ID || ''
};
