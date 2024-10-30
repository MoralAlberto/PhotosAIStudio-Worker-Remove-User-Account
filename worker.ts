/// <reference types="@cloudflare/workers-types" />
import { createClient } from '@supabase/supabase-js'

interface DeleteUserRequest {
    user_id: string;
}

export interface Env {
    BUCKET: R2Bucket;
    SUPABASE_URL: string;
    SUPABASE_KEY: string;
}

const securityHeaders = {
    'Content-Type': 'application/json'
};

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        console.log('[Request] Processing deletion request');

        if (request.method !== 'POST') {
            return new Response(JSON.stringify({ error: 'Method not allowed' }), { 
                status: 405,
                headers: securityHeaders 
            });
        }

        const authHeader = request.headers.get('Authorization');
        if (!authHeader?.startsWith('Bearer ')) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { 
                status: 401,
                headers: securityHeaders 
            });
        }

        try {
            const { user_id } = await request.json() as DeleteUserRequest;
            console.log('[Request] User ID:', user_id);

            const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
            const token = authHeader.split(' ')[1];
            
            console.log('[Auth] Verifying user token');
            const { data: { user }, error: authError } = await supabase.auth.getUser(token);
            
            if (authError) {
                console.log('[Auth] Error:', authError);
                return new Response(JSON.stringify({ error: 'Invalid authentication' }), { 
                    status: 401,
                    headers: securityHeaders 
                });
            }

            if (!user) {
                console.log('[Auth] No user found');
                return new Response(JSON.stringify({ error: 'User not found' }), { 
                    status: 401,
                    headers: securityHeaders 
                });
            }

            console.log('[Auth] User verified:', user.id);

            if (user_id.toLowerCase() !== user.id.toLowerCase()) {
                console.log('[Auth] User ID mismatch');
                return new Response(JSON.stringify({ error: 'Unauthorized access' }), { 
                    status: 403,
                    headers: securityHeaders 
                });
            }

            const result = await deleteUserData(user_id.toLowerCase(), env);
            
            return new Response(JSON.stringify({ 
                message: 'User data deleted successfully',
                details: result 
            }), { 
                status: 200,
                headers: securityHeaders 
            });

        } catch (error) {
            console.error('[Error] Unhandled error:', error);
            return new Response(JSON.stringify({ error: 'Internal server error' }), { 
                status: 500,
                headers: securityHeaders 
            });
        }
    }
};

async function deleteUserData(
    user_id: string,
    env: Env
): Promise<Record<string, any>> {
    console.log('[Delete] Starting deletion process');
    const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_KEY);
    const results: Record<string, any> = {};

    try {
        // 1. Borrar predicciones
        console.log('[Delete] Deleting predictions');
        const { error: predError } = await supabase
            .from('replicate_predictions')
            .delete()
            .eq('user_id', user_id);
        
        results.predictions = predError ? 'error' : 'success';
        if (predError) console.error('[Error] Predictions:', predError);

        // 2. Borrar trainings
        console.log('[Delete] Deleting trainings');
        const { error: trainError } = await supabase
            .from('replicate_trainings')
            .delete()
            .eq('user_id', user_id);
        
        results.trainings = trainError ? 'error' : 'success';
        if (trainError) console.error('[Error] Trainings:', trainError);

        // 3. Borrar push token
        console.log('[Delete] Deleting push token');
        const { error: tokenError } = await supabase
            .from('push_tokens')
            .delete()
            .eq('user_id', user_id);
        
        results.pushToken = tokenError ? 'error' : 'success';
        if (tokenError) console.error('[Error] Push token:', tokenError);

        // 4. Borrar créditos y transacciones
        console.log('[Delete] Deleting credits and transactions');
        const { error: creditsError } = await supabase
            .from('user_credits')
            .delete()
            .eq('user_id', user_id);
        
        results.credits = creditsError ? 'error' : 'success';
        if (creditsError) console.error('[Error] Credits:', creditsError);

        const { error: transError } = await supabase
            .from('transactions')
            .delete()
            .eq('user_id', user_id);
        
        results.transactions = transError ? 'error' : 'success';
        if (transError) console.error('[Error] Transactions:', transError);

        // 5. Borrar carpeta del usuario en R2
        console.log('[Delete] Deleting user folder from R2');
        try {
            const objects = await env.BUCKET.list({ prefix: `${user_id}/` });
            if (objects.objects.length > 0) {
                await Promise.all(objects.objects.map(obj => env.BUCKET.delete(obj.key)));
                results.r2Folder = 'success';
                console.log(`[Delete] Deleted ${objects.objects.length} files from R2`);
            } else {
                results.r2Folder = 'no files found';
                console.log('[Delete] No files found in R2');
            }
        } catch (r2Error) {
            results.r2Folder = 'error';
            console.error('[Error] R2:', r2Error);
        }

        // 6. Borrar autenticación
        console.log('[Delete] Deleting user authentication');
        const { error: authError } = await supabase.auth.admin.deleteUser(user_id);
        results.auth = authError ? 'error' : 'success';
        if (authError) console.error('[Error] Auth deletion:', authError);

        console.log('[Success] Deletion process completed');
        return results;

    } catch (error) {
        console.error('[Error] Deletion failed:', error);
        return { ...results, error: 'Process failed' };
    }
}