/// <reference types="@cloudflare/workers-types" />
import { createClient } from '@supabase/supabase-js'

export interface Env {
  BUCKET: R2Bucket;
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log('Received request:', request.method, request.url);
    
    if (request.method !== 'POST') {
      console.log('Method not allowed:', request.method);
      return new Response('Method not allowed', { status: 405 });
    }

    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log('Missing or invalid Authorization header');
      return new Response('Unauthorized', { status: 401 });
    }

    const token = authHeader.split(' ')[1];
    console.log('Extracted token:', token.substring(0, 10) + '...');
    
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    console.log('Supabase client created');

    // Verify the user's token
    console.log('Verifying user token');
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);

    if (authError || !user) {
      console.error('Authentication error:', authError);
      return new Response('Unauthorized', { status: 401 });
    }

    console.log('User authenticated:', user.id);

    const { user_id } = await request.json() as { user_id: string };
    console.log('Received user_id:', user_id);

    if (!user_id || user_id.toLowerCase() !== user.id.toLowerCase()) {
      console.log('Unauthorized or invalid user_id. Received:', user_id, 'Expected:', user.id);
      return new Response('Unauthorized or invalid user_id', { status: 403 });
    }

    console.log(`Starting data deletion for user ${user_id.toLowerCase()}`);

    try {
      await deleteUserData(user_id.toLowerCase(), env);
      console.log('User data deletion completed successfully');
      return new Response('User data deleted successfully', { status: 200 });
    } catch (error) {
      console.error('Error deleting user data:', error);
      return new Response('Error deleting user data', { status: 500 });
    }
  }
};

async function deleteUserData(user_id: string, env: Env): Promise<void> {
  console.log('deleteUserData function called for user:', user_id);
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);

  console.log('Deleting predictions and associated images');
  await deletePredictions(user_id, supabase, env.BUCKET);

  console.log('Deleting trainings and associated images');
  await deleteTrainings(user_id, supabase, env.BUCKET);

  console.log('Deleting push token');
  await deletePushToken(user_id, supabase);

  console.log('Deleting user credits and transactions');
  await deleteCoinsAndTransactions(user_id, supabase);

  console.log('Deleting user folder in R2');
  await deleteUserFolder(user_id, env.BUCKET);

  console.log('Deleting user from authentication table');
  await deleteUserAuth(user_id, supabase);

  console.log(`Data for user ${user_id} completely deleted`);
}

async function deletePredictions(user_id: string, supabase: any, bucket: R2Bucket): Promise<void> {
  const { data: predictions, error } = await supabase
    .from('replicate_predictions')
    .select('id, replicate_id, output_url, input_url')
    .eq('user_id', user_id);

  if (error) {
    console.error('Error fetching predictions:', error);
    return;
  }

  for (const prediction of predictions) {
    // Delete images from R2
    if (prediction.input_url) {
      await deleteR2Object(bucket, prediction.input_url);
      await deleteR2Object(bucket, prediction.input_url.replace(/\.[^/.]+$/, "") + "_mask.png");
    }
    if (prediction.output_url && Array.isArray(prediction.output_url)) {
      for (const url of prediction.output_url) {
        await deleteR2Object(bucket, url);
      }
    }

    // Delete prediction from Supabase
    const { error: deleteError } = await supabase
      .from('replicate_predictions')
      .delete()
      .eq('id', prediction.id);
    
    if (deleteError) {
      console.error(`Error deleting prediction ${prediction.id}:`, deleteError);
    }
  }

  console.log(`${predictions.length} predictions deleted for user ${user_id}`);
}

async function deleteTrainings(user_id: string, supabase: any, bucket: R2Bucket): Promise<void> {
  const { data: trainings, error } = await supabase
    .from('replicate_trainings')
    .select('id, replicate_id, input_images')
    .eq('user_id', user_id);

  if (error) {
    console.error('Error fetching trainings:', error);
    return;
  }

  for (const training of trainings) {
    // Delete input images from R2
    await deleteR2Object(bucket, training.input_images);

    // Delete training from Supabase
    const { error: deleteError } = await supabase
      .from('replicate_trainings')
      .delete()
      .eq('id', training.id);
    
    if (deleteError) {
      console.error(`Error deleting training ${training.id}:`, deleteError);
    }
  }

  console.log(`${trainings.length} trainings deleted for user ${user_id}`);
}

async function deletePushToken(user_id: string, supabase: any): Promise<void> {
  const { error } = await supabase
    .from('push_tokens')
    .delete()
    .eq('user_id', user_id);

  if (error) {
    console.error('Error deleting push token:', error);
  } else {
    console.log(`Push token deleted for user ${user_id}`);
  }
}

async function deleteCoinsAndTransactions(user_id: string, supabase: any): Promise<void> {
  // Delete user credits
  const { error: creditsError } = await supabase
    .from('user_credits')
    .delete()
    .eq('user_id', user_id);

  if (creditsError) {
    console.error('Error deleting user credits:', creditsError);
  } else {
    console.log(`User credits deleted for user ${user_id}`);
  }

  // Delete transactions
  const { error: transactionsError } = await supabase
    .from('transactions')
    .delete()
    .eq('user_id', user_id);

  if (transactionsError) {
    console.error('Error deleting transactions:', transactionsError);
  } else {
    console.log(`Transactions deleted for user ${user_id}`);
  }
}

async function deleteUserFolder(user_id: string, bucket: R2Bucket): Promise<void> {
  try {
    const objects = await bucket.list({ prefix: `${user_id}/` });
    if (objects.objects.length > 0) {
      await bucket.delete(objects.objects.map(obj => obj.key));
      console.log(`User folder ${user_id}/ and all its contents deleted from R2`);
    } else {
      console.log(`No objects found in user folder ${user_id}/`);
    }
  } catch (error) {
    console.error(`Error deleting user folder ${user_id}/ from R2:`, error);
  }
}

async function deleteR2Object(bucket: R2Bucket, url: string): Promise<void> {
  const objectKey = new URL(url).pathname.slice(1);
  try {
    await bucket.delete(objectKey);
    console.log(`Object ${objectKey} deleted from R2`);
  } catch (error) {
    console.error(`Error deleting object ${objectKey} from R2:`, error);
  }
}

async function deleteUserAuth(user_id: string, supabase: any): Promise<void> {
  console.log(`Attempting to delete user ${user_id} from authentication`);
  const { error } = await supabase.auth.admin.deleteUser(user_id);

  if (error) {
    console.error('Error deleting user from authentication:', error);
  } else {
    console.log(`User ${user_id} deleted from authentication`);
  }
}
